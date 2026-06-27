import { Characteristics } from '../../Platform';
import { Command } from 'overkiz-client';
import HeatingSystem from '../HeatingSystem';

export default class AtlanticPassAPCHeatingAndCoolingZone extends HeatingSystem {
    protected THERMOSTAT_CHARACTERISTICS = ['prog'];
    protected MIN_TEMP = 16;
    protected MAX_TEMP = 30;
    // Stable, complete set of valid modes. We deliberately do NOT narrow this at
    // runtime: a reversible heat pump genuinely supports both HEAT and COOL over
    // the year, and HomeKit caches validValues. If we shrank the set (e.g. to
    // [HEAT, OFF] while the zone is off and getHeatingCooling() falls back to
    // Heating), HomeKit could still hold a cached COOL value; the next "turn on"
    // tap would write COOL, HAP would reject it as out-of-validValues BEFORE our
    // onSet runs, and the accessory shows "No Response" with no log. Keeping every
    // on-mode valid means any value HomeKit writes is accepted and then routed to
    // the season-correct command by getHeatingCooling().
    protected TARGET_MODES = [
        Characteristics.TargetHeatingCoolingState.OFF,
        Characteristics.TargetHeatingCoolingState.HEAT,
        Characteristics.TargetHeatingCoolingState.COOL,
    ];

    private warnedHeatingCoolingFallback = false;

    protected applyConfig(config) {
        super.applyConfig(config);
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

        // Report HEAT/COOL (not AUTO) so HomeKit shows a meaningful label
        // ("Chauffer"/"Refroidir"). validValues stays the stable TARGET_MODES set
        // — we never narrow it at runtime (see TARGET_MODES for why).
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
    private getHeatingCooling(): 'Heating' | 'Cooling' {
        // Preferred source: the parent zone-control operating mode.
        const operatingMode = this.device.parent?.get('io:PassAPCOperatingModeState');
        if (operatingMode === 'cooling') {
            return 'Cooling';
        }
        if (operatingMode === 'heating') {
            return 'Heating';
        }

        // Parent state often unavailable (parent not mapped / not yet loaded).
        // Infer from this zone's own on/off states before falling back.
        const coolingOn = this.device.get('core:CoolingOnOffState') === 'on';
        const heatingOn = this.device.get('core:HeatingOnOffState') === 'on';
        if (coolingOn && !heatingOn) {
            return 'Cooling';
        }
        if (heatingOn && !coolingOn) {
            return 'Heating';
        }

        // Last resort: prefer the mode the device actually exposes commands for.
        if (this.device.hasCommand('setCoolingOnOffState') && !this.device.hasCommand('setHeatingOnOffState')) {
            return 'Cooling';
        }
        if (!this.warnedHeatingCoolingFallback) {
            this.warnedHeatingCoolingFallback = true;
            this.warn(`getHeatingCooling: operating mode is "${operatingMode}" and zone states are ambiguous, defaulting to Heating`);
        }
        return 'Heating';
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
