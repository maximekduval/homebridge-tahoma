import { Characteristics } from '../../Platform';
import { Command } from 'overkiz-client';
import HeatingSystem from '../HeatingSystem';

export default class AtlanticPassAPCHeatingAndCoolingZone extends HeatingSystem {
    protected THERMOSTAT_CHARACTERISTICS = ['prog'];
    protected MIN_TEMP = 16;
    protected MAX_TEMP = 30;
    // STATIC, complete set — published once at startup and never changed at runtime.
    //
    // We deliberately do NOT narrow this to the active season, even though a zone
    // can only be in the season the main controller dictates. Two HomeKit facts make
    // dynamic narrowing unworkable:
    //  1. iOS caches characteristic metadata (validValues) and only re-reads it when
    //     the accessory's configuration number changes. setProps() at runtime is not
    //     reliably picked up, and once iOS has cached a narrowed set, reverting the
    //     plugin doesn't clear it (needs a Home-hub restart / re-pair).
    //  2. HAP validates a write against validValues BEFORE onSet runs. Turning a zone
    //     on from off makes iOS write HEAT by default (regardless of our set); if HEAT
    //     isn't valid, HAP rejects it → "No Response" with no log.
    // So we keep every on-mode valid. Picking the "wrong" mode is harmless: getTargetStateCommands()
    // routes the command to the controller's real season via getHeatingCooling().
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
        // ("Chauffer"/"Refroidir"). validValues stays the static TARGET_MODES set —
        // see TARGET_MODES for why we never narrow it at runtime.
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
     * source is ambiguous getHeatingCooling() falls back to Heating for command
     * routing.
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

    private getProfile() {
        const heatingCooling = this.getHeatingCooling();
        const eco = this.device.getNumber(`core:Eco${heatingCooling}TargetTemperatureState`);
        const target = this.device.getNumber('core:TargetTemperatureState');
        // Compare with tolerance: these are floating-point temperatures and exact
        // equality is unreliable.
        return Math.abs(eco - target) < 0.5 ? 'Eco' : 'Comfort';
    }

}
