import { Characteristic, Perms } from 'homebridge';
import { Characteristics, Services } from '../../Platform';
import { Command, ExecutionState } from 'overkiz-client';
import HeatingSystem from '../HeatingSystem';

// Values reported by io:PassAPCOperatingModeState / accepted by setPassAPCOperatingMode.
enum PassAPCOperatingMode {
    Auto = 'auto',
    Cooling = 'cooling',
    Drying = 'drying',
    Heating = 'heating',
    Stop = 'stop',
}

export default class AtlanticPassAPCZoneControl extends HeatingSystem {
    protected TARGET_MODES = [
        Characteristics.TargetHeatingCoolingState.AUTO,
        Characteristics.TargetHeatingCoolingState.HEAT,
        Characteristics.TargetHeatingCoolingState.COOL,
        Characteristics.TargetHeatingCoolingState.OFF,
    ];

    // HomeKit's Thermostat has no "dry" mode: the dehumidifier mode is exposed
    // as a dedicated switch next to the thermostat.
    protected dehumidifier: Characteristic | undefined;

    protected registerServices() {
        const services = super.registerServices();
        const dehumidifier = this.registerService(Services.Switch, 'dehumidifier');
        this.dehumidifier = dehumidifier.getCharacteristic(Characteristics.On);
        this.dehumidifier.onSet((value) => {
            this.setDehumidifier(value).catch(e => this.error('setDehumidifier failed:', e));
        });
        services.push(dehumidifier);
        return services;
    }

    protected registerMainService() {
        const service = super.registerMainService();
        this.targetTemperature?.setProps({ perms: [Perms.PAIRED_READ, Perms.EVENTS] });
        return service;
    }

    protected getTargetStateCommands(value): Command | Array<Command> {
        switch (value) {
            case Characteristics.TargetHeatingCoolingState.AUTO:
                return [
                    new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Heating),
                    new Command('setHeatingCoolingAutoSwitch', 'on'),
                ];

            case Characteristics.TargetHeatingCoolingState.HEAT:
                return [
                    new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Heating),
                    new Command('setHeatingCoolingAutoSwitch', 'off'),
                ];

            case Characteristics.TargetHeatingCoolingState.COOL:
                return [
                    new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Cooling),
                    new Command('setHeatingCoolingAutoSwitch', 'off'),
                ];

            default:
            case Characteristics.TargetHeatingCoolingState.OFF:
                return [
                    new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Stop),
                ];
        }
    }

    protected getDehumidifierCommands(value): Array<Command> {
        if (value) {
            return [
                new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Drying),
                new Command('setHeatingCoolingAutoSwitch', 'off'),
            ];
        }
        return [new Command('setPassAPCOperatingMode', PassAPCOperatingMode.Stop)];
    }

    protected async setDehumidifier(value) {
        const action = await this.executeCommands(this.getDehumidifierCommands(value));
        action.on('update', (state) => {
            if (state === ExecutionState.FAILED) {
                this.dehumidifier?.updateValue(!value);
            }
        });
    }

    protected getTargetTemperatureCommands(value): Command | Array<Command> {
        return [];
    }

    protected onStateChanged(name, value) {
        switch (name) {
            case 'io:PassAPCOperatingModeState':
            case 'core:HeatingCoolingAutoSwitchState':
                this.postpone(this.computeStates);
                break;
            default:
                super.onStateChanged(name, value);
                break;
        }
    }

    protected computeStates() {
        const isAuto = this.device.get('core:HeatingCoolingAutoSwitchState') === 'on';
        let targetState;
        let currentState;
        switch (this.device.get('io:PassAPCOperatingModeState')) {
            case PassAPCOperatingMode.Heating:
                targetState = isAuto
                    ? Characteristics.TargetHeatingCoolingState.AUTO
                    : Characteristics.TargetHeatingCoolingState.HEAT;
                currentState = Characteristics.CurrentHeatingCoolingState.HEAT;
                break;
            case PassAPCOperatingMode.Cooling:
                targetState = isAuto
                    ? Characteristics.TargetHeatingCoolingState.AUTO
                    : Characteristics.TargetHeatingCoolingState.COOL;
                currentState = Characteristics.CurrentHeatingCoolingState.COOL;
                break;
            case PassAPCOperatingMode.Auto:
                targetState = Characteristics.TargetHeatingCoolingState.AUTO;
                break;
            case PassAPCOperatingMode.Drying:
                // Neither heating nor cooling: the thermostat shows "Off" and the
                // dehumidifier switch carries the mode. Previously this state was
                // ignored, so HomeKit kept showing the last mode (often "Heat").
                targetState = Characteristics.TargetHeatingCoolingState.OFF;
                currentState = Characteristics.CurrentHeatingCoolingState.OFF;
                break;
            case PassAPCOperatingMode.Stop:
                targetState = Characteristics.TargetHeatingCoolingState.OFF;
                currentState = Characteristics.CurrentHeatingCoolingState.OFF;
                break;
        }

        if (currentState !== undefined) {
            this.currentState?.updateValue(currentState);
        }

        if (targetState !== undefined && this.isIdle) {
            this.targetState?.updateValue(targetState);
            this.dehumidifier?.updateValue(this.device.get('io:PassAPCOperatingModeState') === PassAPCOperatingMode.Drying);
        }
    }
}
