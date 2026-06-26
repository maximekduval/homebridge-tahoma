import { Characteristics } from '../../Platform';
import { Command, ExecutionState } from 'overkiz-client';
import HeatingSystem from '../HeatingSystem';

export default class AtlanticPassAPCHeatingAndCoolingZone extends HeatingSystem {
    protected THERMOSTAT_CHARACTERISTICS = ['prog'];
    protected MIN_TEMP = 16;
    protected MAX_TEMP = 30;
    protected TARGET_MODES = [
        Characteristics.TargetHeatingCoolingState.AUTO,
        Characteristics.TargetHeatingCoolingState.OFF,
    ];

    protected applyConfig(config) {
        super.applyConfig(config);
    }

    protected getTargetStateCommands(value): Command | Array<Command> {
        const heatingCooling = this.getHeatingCooling();
        const commands: Array<Command> = [];
        switch (value) {
            case Characteristics.TargetHeatingCoolingState.AUTO:
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
            if (temp !== undefined && temp >= 16) {
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
                if (value >= 16) {
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
            targetState = Characteristics.TargetHeatingCoolingState.AUTO;
        }

        if (this.device.get(`io:PassAPC${heatingCooling}ModeState`) === 'internalScheduling') {
            this.prog?.updateValue(true);
        } else {
            this.prog?.updateValue(false);
        }



        if (this.targetState !== undefined && targetState !== undefined && this.isIdle) {
            this.targetState.updateValue(targetState);
        }

        if (this.targetTemperature !== undefined && targetTemperature >= 16 && this.isIdle) {
            this.lastConfirmedTemperature = targetTemperature;
            this.targetTemperature.updateValue(targetTemperature);
        }
    }

    protected async setTargetTemperature(value) {
        const action = await this.executeCommands(this.getTargetTemperatureCommands(value));
        action.on('update', (state) => {
            if (state === ExecutionState.FAILED && this.lastConfirmedTemperature !== undefined) {
                this.warn('setTargetTemperature failed, reverting to', this.lastConfirmedTemperature);
                this.targetTemperature?.updateValue(this.lastConfirmedTemperature);
            }
        });
    }

    /**
     * Helpers
     */
    private getHeatingCooling() {
        const operatingMode = this.device.parent?.get('io:PassAPCOperatingModeState');
        if (operatingMode === 'cooling') {
            return 'Cooling';
        } else if (operatingMode === 'heating') {
            return 'Heating';
        } else {
            this.warn(`getHeatingCooling: parent state is "${operatingMode}", defaulting to Heating`);
            return 'Heating';
        }
    }

    private getProfile() {
        const heatingCooling = this.getHeatingCooling();
        if (this.device.get(`core:Eco${heatingCooling}TargetTemperatureState`) === this.device.get('core:TargetTemperatureState')) {
            return 'Eco';
        } else {
            return 'Comfort';
        }
    }

}
