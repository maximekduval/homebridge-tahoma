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

### Phase 1 — Couche commandes/synchro
4. C1 : poignée par-appel au lieu de rempiler sur l'Action partagée.
5. C2 : flag « busy » synchrone ; `isIdle` fiable.
6. C4 : gestion d'erreur/revert uniforme.
- ✅ Tests : N commandes rapides → 1 exécution, 0 listener résiduel ; échec → 1 revert ; état retardé n'écrase pas la consigne en vol.

### Phase 2 — Thermostats Atlantic/Cozytouch
7. C3 : déterminer le mode depuis les états du device (parent en fallback).
8. O1/O4 : remonter `lastConfirmedTemperature`/`onGet`/`MIN_TEMP` dans la base.
9. O2/O3 : retirer court-circuit ; comparaison à tolérance.
- ✅ Tests unitaires getHeatingCooling / getTargetTemperatureCommands / computeStates + validation manuelle chauffage↔clim.

### Phase 3 — Plateforme & hygiène
10. O5 : encadrer les handlers process.
11. Plafonner le backoff `discoverDevices` ; décider réconciliation accessoires.
12. Q4/Q5/Q6 : code mort, engines, `noImplicitAny` progressif.
- ✅ tsc strict OK fichiers migrés ; backoff plafonné ; pas d'accessoires fantômes.

### Phase 4 — Couverture & CI
13. Tests des mappers majeurs (RollerShutter, OnOff, Light, WaterHeatingSystem).
14. CI lint+build+test.
- ✅ Couverture cible cœur ; CI verte.
