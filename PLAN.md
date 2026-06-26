# Plan d'amélioration — homebridge-tahoma

Objectif : rendre le plugin fiable, correct et stable (focus sur les bugs de
rafraîchissement de valeurs, consignes de température non prises en compte et
problèmes de synchronisation).

Décisions actées :
- Refactor **ciblé** de la couche commandes (sans casser l'API des mappers).
- Tests avec **Vitest**.
- Plan sauvegardé, puis exécution Phase 0 → 4.

---

## Problèmes identifiés

### 🔴 Critiques
- **C0 — Bug dans `overkiz-client` `Action.addCommands` (commandes perdues).**
  La méthode itère `this.commands` (existantes) au lieu du paramètre `commands` :
  toute 2ᵉ commande *distincte* envoyée au même appareil dans la fenêtre de batch
  (100ms) est **silencieusement abandonnée**. Cause directe de "consigne envoyée
  mais non appliquée". Détecté par test de caractérisation (`it.fails`). À
  contourner côté plugin en Phase 1 (ne pas dépendre d'`addCommands` pour des
  commandes distinctes) et/ou corriger en amont.

- **C1 — Fuite/empilement de listeners `action.on('update')`.** `executeCommands`
  réutilise la même `Action` (batching), chaque setter rempile un listener sur
  l'action partagée → dépassement MaxListeners + reverts/positions multiples.
- **C2 — Race `isIdle`/`executionId`.** `executionId` n'est posé qu'après l'await
  d'`executeAction` ; pendant ~100ms+ `isIdle` reflète l'ancienne exécution, donc
  un état serveur en retard peut écraser la consigne juste envoyée.
- **C3 — `getHeatingCooling()` dépend du parent souvent absent** → fallback
  systématique sur `Heating`, mauvaises commandes/lectures en mode clim.
- **C4 — Setters non-debouncés sans `.catch`** → pas de revert UI cohérent en
  cas d'échec de communication.

### 🟠 Importants
- **O1** — `onGet` + `lastConfirmedTemperature` présents sur un seul mapper.
- **O2** — `setTargetState` court-circuité par `value===targetState.value`
  (empêche de forcer en cas de désync).
- **O3** — `getProfile()` compare des températures par `===`.
- **O4** — Seuils magiques `>= 16` dupliqués au lieu de `MIN_TEMP`.
- **O5** — Handlers `unhandledRejection`/`uncaughtException` non encadrés.

### 🟡 Qualité
- **Q1** Aucun test. **Q2** 21 erreurs ESLint (publication via `prepublishOnly`).
- **Q3** Newline final manquant. **Q4** Code mort commenté.
- **Q5** `engines.node` incohérent. **Q6** `any` généralisé.

---

## Phases (chacune avec vérification)

### Phase 0 — Filet & baseline ✅ TERMINÉE
1. ✅ Harnais Vitest + mocks (`test/helpers.ts`).
2. ✅ Tests de caractérisation de `executeCommands` (`test/Mapper.test.ts`) — dont
   `it.fails` documentant C0.
3. ✅ ESLint migré en flat config (`eslint.config.js`, déterministe sur tout `src/`),
   21 erreurs corrigées (imports/args morts), newline ajoutée, scripts `test`/`lint`
   mis à jour dans `package.json`.
- ✅ Vérifié : `npm run lint` 0 erreur/0 warning ; `tsc --noEmit` OK ;
  `npm run build` OK ; `npm test` vert (6 + 1 expected-fail) ; entrypoint
  `dist/index.js` se charge et enregistre la plateforme.

### Phase 1 — Couche commandes/synchro ✅ TERMINÉE
4. ✅ C0 : `mergeCommands()` remplace l'`addCommands` buggé d'overkiz-client — les
   commandes distinctes batchées ne sont plus perdues.
5. ✅ C2 : compteur `inFlight` synchrone (incrémenté à l'émission, décrémenté à
   l'état terminal ou à l'échec d'envoi) ; `isIdle = inFlight===0 && !hasExecution`.
   Ferme la fenêtre où un écho serveur écrasait la consigne juste envoyée.
6. ✅ C1 : `action.setMaxListeners(0)` + libération unique via garde `settled` →
   plus de warning de fuite EventEmitter sur l'action partagée.
7. ✅ Gestion des états terminaux étendue (TIMED_OUT/NOT_TRANSMITTED) + `event?.`
   défensif.
- ✅ Vérifié : `npm test` 12/12 (dont C0 fixé + 4 tests C2 in-flight) ; lint 0 ;
  `tsc` OK ; build OK ; entrypoint se charge.
- ↪ C4 : la propagation des rejets vers HomeKit (setters non-debouncés) + le log
  des erreurs du debounce (session précédente) sont jugés suffisants ; pas de
  churn ajouté.

### Phase 2 — Thermostats Atlantic/Cozytouch ✅ TERMINÉE
7. ✅ C3 : `getHeatingCooling()` n'est plus tributaire du parent — cascade parent →
   états `core:Heating/CoolingOnOffState` du zone → commandes exposées → défaut
   `Heating` avec warning **une seule fois** (plus de spam dans computeStates).
8. ✅ O4 : tous les `>= 16` magiques remplacés par `this.MIN_TEMP`. O1 : le
   `setTargetTemperature` redondant de la sous-classe Atlantic supprimé (hérite du
   revert de la base). Généralisation d'un `onGet` à toute la base **non faite** à
   dessein (risque de régression sur des sous-classes non couvertes par tests).
9. ✅ O2 : court-circuit `value===targetState.value` retiré (permet de re-forcer un
   device désynchronisé). O3 : `getProfile()` compare désormais avec tolérance
   (0.5°C) via `getNumber`, au lieu d'un `===` de flottants.
- ✅ Vérifié : `npm test` 27/27 (15 nouveaux : getHeatingCooling ×6, getProfile ×2,
  getTargetTemperatureCommands ×3, computeStates ×4 dont anti-écrasement C2) ;
  lint src+test 0 ; `tsc` OK ; build OK ; entrypoint se charge. Reste : validation
  manuelle chauffage↔clim sur installation réelle.

### Phase 3 — Plateforme & hygiène ✅ TERMINÉE
10. ✅ O5 : handlers `process` (`unhandledRejection`/`uncaughtException`) installés
    une seule fois via garde module-level (`processHandlersInstalled`) + messages
    étiquetés. Évite la fuite/duplication avec plusieurs comptes TaHoma.
11. ✅ Backoff `discoverDevices` plafonné à `MAX_RETRY_DELAY = 600s`
    (`Math.min(retryDelay*2, MAX)`). Réconciliation : confirmée déléguée au
    `mapper.build()` (qui retire déjà les services obsolètes) → bloc mort en
    doublon supprimé.
12. ✅ Q4 : code mort retiré (bloc `renommage` commenté dans `registerService`,
    champ `config` commenté, blocs commentés de `discoverDevices`). Q5 :
    `engines.node` `>=12.4.0` → `>=18.0.0`, `homebridge` → `>=1.6.0`.
    Q6 (`noImplicitAny`) **différé** : activer toucherait des dizaines de fichiers
    (params `value`/`name`/`config` non typés) — trop risqué hors d'un chantier
    dédié.
- ✅ Vérifié : lint src+test 0 ; `tsc` OK ; build OK ; `npm test` 27/27 ;
  entrypoint se charge.

### Phase 4 — Couverture & CI
13. Tests des mappers majeurs (RollerShutter, OnOff, Light, WaterHeatingSystem).
14. CI lint+build+test.
- ✅ Couverture cible cœur ; CI verte.
