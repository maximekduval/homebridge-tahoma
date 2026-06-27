import { Characteristics } from '../../Platform';
import { Command } from 'overkiz-client';
import HeatingSystem from '../HeatingSystem';

export default class AtlanticPassAPCHeatingAndCoolingZone extends HeatingSystem {
    protected THERMOSTAT_CHARACTERISTICS = ['prog'];
    protected MIN_TEMP = 16;
    protected MAX_TEMP = 30;
    // Complete set published at startup and whenever the zone is off.
    // updateValidModes() narrows it to OFF + the active season (HEAT or COOL) only
    // while the zone is ON and the season is known reliably, so a running zone tile
    // can't be flipped to the wrong season.
    //
    // Why the full set must stay while off: HomeKit validates a write against
    // validValues BEFORE our onSet runs. Turning a zone back on from off makes
    // HomeKit write an on-mode; if that mode isn't in the set, HAP rejects it and
    // the accessory shows "No Response" with no log. The full set is the known-good
    // set for that activation path, so we keep it whenever the zone is off.
    protected TARGET_MODES = [
        Characteristics.TargetHeatingCoolingState.OFF,
        Characteristics.TargetHeatingCoolingState.HEAT,
        Characteristics.TargetHeatingCoolingState.COOL,
    ];

    private warnedHeatingCoolingFallback = false;

    protected applyConfig(config) {
        super.applyConfig(config);
    }

    protected async setTargetState(value, attempt = 0) {
        // When turning a zone on from off, iOS Home defaults the written mode to
        // HEAT (the first non-off TargetHeatingCoolingState), regardless of the
        // heat pump's actual season. The command is routed to the right season by
        // getTargetStateCommands(), but the tile would otherwise flash "heating"
        // until the server round-trip lets computeStates() correct it. Snap the UI
        // to the real season immediately so there's no visible wrong-mode flash.
        if (value !== Characteristics.TargetHeatingCoolingState.OFF) {
            const seasonMode = this.getHeatingCooling() === 'Cooling'
                ? Characteristics.TargetHeatingCoolingState.COOL
                : Characteristics.TargetHeatingCoolingState.HEAT;
            if (value !== seasonMode) {
                this.targetState?.updateValue(seasonMode);
            }
        }
        return super.setTargetState(value, attempt);
    }

    protected getTargetStateCommands(value): Command | Array<Command> {
        const heatingCooling = this.getHeatingCooling();
        const commands: Array<Command> = [];
        switch (value) {
            case Characteristics.TargetHeatingCoolingState.AUTO:
            case Characteristics.TargetHeatingCoolingState.HEAT:
            case Characteristics.TargetHeatingCoolingState.COOL:
                commands.push(new Command('set' + heatingCooling + 'OnOffState', 'on'));
                commands.push(new Command('setPassAPC' + heatingCooling + 'Mode', this.prog?.value ? 'internalScheduling' : 'manu'));
                break;

            case Characteristics.TargetHeatingCoolingState.OFF:
                commands.push(new Command('set' + heatingCooling + 'OnOffState', 'off'));
                break;
        }

        return commands;
    }

    protected getTargetTemperatureCommands(value): Command | Array<Command> {
        const heatingCooling = this.getHeatingCooling();
        if (this.prog?.value) {
            if (this.device.hasCommand('setDerogatedTargetTemperature')) {
                // AtlanticPassAPCHeatPump
                return [
                    new Command('setDerogatedTargetTemperature', value),
                    new Command('setDerogationTime', this.derogationDuration),
                    new Command('setDerogationOnOffState', 'on'),
                ];
            } else {
                const profile = this.getProfile();
                return new Command(`set${profile}${heatingCooling}TargetTemperature`, value);
            }
        } else {
            if (this.device.hasCommand(`set${heatingCooling}TargetTemperature`)) {
                // AtlanticPassAPCZoneControl
                return new Command(`set${heatingCooling}TargetTemperature`, value);
            } else {
                // AtlanticPassAPCHeatPump
                return new Command(`setComfort${heatingCooling}TargetTemperature`, value);
            }
        }
    }

    protected registerMainService() {
        const service = super.registerMainService();
        this.targetTemperature?.onGet(() => {
            const heatingCooling = this.getHeatingCooling();
            const temp = this.device.get(`core:${heatingCooling}TargetTemperatureState`)
                      || this.device.get('core:TargetTemperatureState');
            if (temp !== undefined && temp >= this.MIN_TEMP) {
                return temp;
            }
            return this.lastConfirmedTemperature ?? this.MIN_TEMP;
        });
        // super published the full TARGET_MODES set; narrow it to the current
        // season if we can read it reliably at startup.
        this.updateValidModes();
        return service;
    }

    protected onStateChanged(name, value) {
        switch (name) {
            case 'core:TemperatureState':
                this.onTemperatureUpdate(value);
                break;
            case 'core:TargetTemperatureState':
                if (value >= this.MIN_TEMP) {
                    this.lastConfirmedTemperature = value;
                    this.targetTemperature?.updateValue(value);
                }
                break;
            case 'core:CoolingTargetTemperatureState':
            case 'core:HeatingTargetTemperatureState':
                this.postpone(this.computeStates);
                break;
            case 'core:HeatingOnOffState':
            case 'core:CoolingOnOffState':
            case 'io:PassAPCHeatingModeState':
            case 'io:PassAPCCoolingModeState':
            case 'io:PassAPCHeatingProfileState':
            case 'io:PassAPCCoolingProfileState':
                this.postpone(this.computeStates);
                break;
            default:
                super.onStateChanged(name, value);
                break;
        }
    }

    protected computeStates() {
        let targetState;
        let targetTemperature;
        const heatingCooling = this.getHeatingCooling();

        // Keep the offered modes in sync with the current season (OFF + the active
        // mode when known, full set when ambiguous). Done before updating the
        // value below so targetState.value (OFF or activeMode) always lands inside
        // the published validValues. See updateValidModes.
        this.updateValidModes();

        // Report HEAT/COOL (not AUTO) so HomeKit shows a meaningful label
        // ("Chauffer"/"Refroidir").
        const activeMode = heatingCooling === 'Cooling'
            ? Characteristics.TargetHeatingCoolingState.COOL
            : Characteristics.TargetHeatingCoolingState.HEAT;

        if (this.device.get(`core:${heatingCooling}OnOffState`) === 'off') {
            targetState = Characteristics.TargetHeatingCoolingState.OFF;
            this.currentState?.updateValue(Characteristics.CurrentHeatingCoolingState.OFF);
        } else {
            targetTemperature = this.device.get(`core:${heatingCooling}TargetTemperatureState`) ||
                this.device.get('core:TargetTemperatureState');
            const currentTemperature = this.currentTemperature?.value || targetTemperature;
            if (heatingCooling === 'Heating') {
                if (currentTemperature >= (targetTemperature + 0.5)) {
                    this.currentState?.updateValue(Characteristics.CurrentHeatingCoolingState.OFF);
                } else {
                    this.currentState?.updateValue(Characteristics.CurrentHeatingCoolingState.HEAT);
                }
            } else {
                if (currentTemperature <= (targetTemperature - 0.5)) {
                    this.currentState?.updateValue(Characteristics.CurrentHeatingCoolingState.OFF);
                } else {
                    this.currentState?.updateValue(Characteristics.CurrentHeatingCoolingState.COOL);
                }
            }
            targetState = activeMode;
        }

        if (this.device.get(`io:PassAPC${heatingCooling}ModeState`) === 'internalScheduling') {
            this.prog?.updateValue(true);
        } else {
            this.prog?.updateValue(false);
        }



        if (this.targetState !== undefined && targetState !== undefined && this.isIdle) {
            this.targetState.updateValue(targetState);
        }

        if (this.targetTemperature !== undefined && targetTemperature >= this.MIN_TEMP && this.isIdle) {
            this.lastConfirmedTemperature = targetTemperature;
            this.targetTemperature.updateValue(targetTemperature);
        }
    }

    // setTargetTemperature is inherited from HeatingSystem: it already reverts to
    // lastConfirmedTemperature on failure, so no override is needed here.

    /**
     * Helpers
     */

    /**
     * Reliable heat-vs-cool season, or undefined when it cannot be trusted.
     *
     * A reversible heat pump's season is chosen by the main controller, never per
     * zone. We only report a mode when it comes from a trustworthy source — the
     * parent controller's operating mode, an unambiguous on/off state on the zone,
     * or a device that physically exposes only one of the two commands. When the
     * source is ambiguous we return undefined so callers don't guess: getHeatingCooling()
     * falls back to Heating for command routing, but updateValidModes() keeps the
     * full mode set instead of shrinking validValues to a guessed (possibly wrong)
     * season — the root cause of the historical "No Response" bug.
     */
    private getOperatingMode(): 'Heating' | 'Cooling' | undefined {
        // Preferred source: the parent zone-control operating mode.
        const operatingMode = this.device.parent?.get('io:PassAPCOperatingModeState');
        if (operatingMode === 'cooling') {
            return 'Cooling';
        }
        if (operatingMode === 'heating') {
            return 'Heating';
        }

        // Parent state often unavailable (parent not mapped / not yet loaded).
        // Infer from this zone's own on/off states before giving up.
        const coolingOn = this.device.get('core:CoolingOnOffState') === 'on';
        const heatingOn = this.device.get('core:HeatingOnOffState') === 'on';
        if (coolingOn && !heatingOn) {
            return 'Cooling';
        }
        if (heatingOn && !coolingOn) {
            return 'Heating';
        }

        // Last resort: a device that physically exposes only one of the commands.
        const canCool = this.device.hasCommand('setCoolingOnOffState');
        const canHeat = this.device.hasCommand('setHeatingOnOffState');
        if (canCool && !canHeat) {
            return 'Cooling';
        }
        if (canHeat && !canCool) {
            return 'Heating';
        }

        // Genuinely ambiguous: let the caller decide what to do.
        return undefined;
    }

    private getHeatingCooling(): 'Heating' | 'Cooling' {
        const mode = this.getOperatingMode();
        if (mode) {
            return mode;
        }
        if (!this.warnedHeatingCoolingFallback) {
            this.warnedHeatingCoolingFallback = true;
            this.warn('getHeatingCooling: operating mode is unknown and zone states are ambiguous, defaulting to Heating');
        }
        return 'Heating';
    }

    /**
     * Restrict the modes HomeKit offers on a *running* zone tile to OFF + the
     * single active season (HEAT or COOL) dictated by the main controller, so a
     * zone that is on can't be flipped to a season the heat pump isn't in.
     *
     * Two hard rules keep this from reintroducing the "No Response" bug (HAP
     * validates a write against validValues BEFORE onSet runs):
     *  1. Only narrow when getOperatingMode() is reliable — never on a guess.
     *  2. Only narrow while the zone is actually ON. When it is off we publish the
     *     full [OFF, HEAT, COOL] set, because turning a zone back on from off makes
     *     HomeKit write an on-mode and that write must always be accepted. (This is
     *     the known-good set: activation from off has always worked with it.)
     * Either condition unmet → full set. See TARGET_MODES and getOperatingMode.
     */
    private updateValidModes() {
        if (!this.targetState) {
            return;
        }
        const C = Characteristics.TargetHeatingCoolingState;
        const mode = this.getOperatingMode();
        const isOn = mode !== undefined && this.device.get(`core:${mode}OnOffState`) === 'on';
        const validValues = !isOn ? [C.OFF, C.HEAT, C.COOL]
            : mode === 'Cooling' ? [C.OFF, C.COOL]
                : [C.OFF, C.HEAT];

        const current = this.targetState.props.validValues as number[] | undefined;
        const unchanged = current !== undefined
            && current.length === validValues.length
            && validValues.every((v) => current.includes(v));
        if (!unchanged) {
            this.targetState.setProps({ validValues });
        }
    }

    private getProfile() {
        const heatingCooling = this.getHeatingCooling();
        const eco = this.device.getNumber(`core:Eco${heatingCooling}TargetTemperatureState`);
        const target = this.device.getNumber('core:TargetTemperatureState');
        // Compare with tolerance: these are floating-point temperatures and exact
        // equality is unreliable.
        return Math.abs(eco - target) < 0.5 ? 'Eco' : 'Comfort';
    }

}
