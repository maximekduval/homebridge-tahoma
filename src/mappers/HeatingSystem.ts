import { Characteristics, Services } from '../Platform';
import { Characteristic, CharacteristicValue, Service } from 'homebridge';
import { Command, ExecutionState } from 'overkiz-client';
import Mapper from '../Mapper';
import { EcoCharacteristic, ProgCharacteristic, TotalConsumptionCharacteristic } from '../CustomCharacteristics';

export default class HeatingSystem extends Mapper {
    protected THERMOSTAT_CHARACTERISTICS: string[] = [];
    protected MIN_TEMP = 7;
    protected MAX_TEMP = 30;
    protected TARGET_MODES = [
        Characteristics.TargetHeatingCoolingState.AUTO,
        Characteristics.TargetHeatingCoolingState.OFF,
    ];

    protected currentTemperature: Characteristic | undefined;
    protected targetTemperature: Characteristic | undefined;
    protected currentState: Characteristic | undefined;
    protected targetState: Characteristic | undefined;
    protected lastConfirmedTemperature: CharacteristicValue | undefined;

    protected on: Characteristic | undefined;

    protected prog: Characteristic | undefined;
    protected eco: Characteristic | undefined;

    protected consumption: Characteristic | undefined;

    protected derogationDuration;
    protected comfortTemperature;
    protected ecoTemperature;

    protected applyConfig(config) {
        this.derogationDuration = config['derogationDuration'] || 1;
        this.comfortTemperature = config['comfort'] || 19;
        this.ecoTemperature = config['eco'] || 17;
    }

    protected registerMainService(): Service {
        const service = this.registerService(Services.Thermostat);
        service.setPrimaryService(true);
        service.addOptionalCharacteristic(ProgCharacteristic);
        service.addOptionalCharacteristic(EcoCharacteristic);
        this.currentTemperature = service.getCharacteristic(Characteristics.CurrentTemperature);
        this.targetTemperature = service.getCharacteristic(Characteristics.TargetTemperature);
        this.currentState = service.getCharacteristic(Characteristics.CurrentHeatingCoolingState);
        this.targetState = service.getCharacteristic(Characteristics.TargetHeatingCoolingState);

        this.currentTemperature.setProps({ minStep: 0.1 });

        this.targetState?.setProps({ validValues: this.TARGET_MODES });
        this.targetTemperature?.setProps({ minValue: this.MIN_TEMP, maxValue: this.MAX_TEMP, minStep: 0.5 });
        const temp = Number(this.targetTemperature.value);
        if (this.targetTemperature && temp < this.targetTemperature.props.minValue!) {
            this.targetTemperature.value = this.targetTemperature.props.minValue!;
        }
        if (this.targetTemperature && temp > this.targetTemperature.props.maxValue!) {
            this.targetTemperature.value = this.targetTemperature.props.maxValue!;
        }

        if (this.THERMOSTAT_CHARACTERISTICS.includes('prog')) {
            this.prog = service.getCharacteristic(ProgCharacteristic);
            this.prog.onSet((value) => {
                this.prog?.updateValue(value);
                this.sendProgCommands();
            });
        }

        if (this.THERMOSTAT_CHARACTERISTICS.includes('eco')) {
            this.eco = service.getCharacteristic(EcoCharacteristic);
            this.eco.onSet((value) => {
                this.eco?.updateValue(value);
                this.sendProgCommands();
            });
        }

        if (this.device.hasSensor('CumulativeElectricPowerConsumptionSensor')) {
            service.addOptionalCharacteristic(TotalConsumptionCharacteristic);
            this.consumption = service.getCharacteristic(TotalConsumptionCharacteristic);
        }

        // Fire-and-forget: don't let HomeKit wait for the HTTP round-trip.
        // If onSet blocks (e.g. the Overkiz pool is full), HomeKit times out and
        // shows "No Response" for the whole accessory. Errors are handled inside
        // setTargetState (retry + UI revert), so no feedback is lost.
        this.targetState?.onSet((value) => {
            this.setTargetState(value).catch(e => this.error('setTargetState failed:', e));
        });
        this.targetTemperature?.onSet(this.debounce(this.setTargetTemperature));
        return service;
    }

    protected registerSwitchService(subtype?: string): Service {
        const service = this.registerService(Services.Switch, subtype);
        this.on = service.getCharacteristic(Characteristics.On);

        this.on?.onSet((value) => {
            this.setOn(value).catch(e => this.error('setOn failed:', e));
        });
        return service;
    }

    protected getTargetStateCommands(value): Command | Array<Command> | undefined {
        switch (value) {
            case Characteristics.TargetHeatingCoolingState.AUTO:
                return new Command('auto');
            case Characteristics.TargetHeatingCoolingState.HEAT:
                return new Command('heat');
            case Characteristics.TargetHeatingCoolingState.COOL:
                return new Command('cool');
            case Characteristics.TargetHeatingCoolingState.OFF:
                return new Command('off');
            default:
                return new Command('auto');
        }
    }

    protected readonly MAX_COMMAND_RETRIES = 5;

    // Failure types that are transient (gateway/transport glitch, or a device
    // that is momentarily not ready) and worth retrying with backoff.
    //
    // DEVICE_DEFECT is included because it is the failure an Atlantic PAC reports
    // when a command lands while the unit is still coming online — e.g. asking
    // for a target temperature (or even the on/off itself) right after switching
    // a cold/off zone on. The backoff (1→2→4→8→16s) gives the unit time to
    // finish starting; if it is genuinely defective we still give up after
    // MAX_COMMAND_RETRIES and revert the UI cleanly.
    protected isRetryable(failureType?: string): boolean {
        return failureType === 'DATA_TRANSPORT_SERVICE_ERROR' ||
               failureType === 'DATA_TRANSPORT_SERVICE_ABORTED_BY_RECIPIENT' ||
               failureType === 'DEVICE_DEFECT';
    }

    protected async setTargetState(value, attempt = 0) {
        // Note: we intentionally do not short-circuit when value equals the
        // current target state — that prevented re-issuing a command to re-sync
        // a device whose real state had drifted from HomeKit's.
        const action = await this.executeCommands(this.getTargetStateCommands(value));
        action.on('update', (state, event) => {
            switch (state) {
                case ExecutionState.COMPLETED:
                    if (this.stateless) {
                        this.currentState?.updateValue(value);
                    }
                    break;
                case ExecutionState.FAILED:
                    if (attempt < this.MAX_COMMAND_RETRIES && this.isRetryable(event?.failureType)) {
                        const delay = Math.min(2 ** attempt * 1_000, 30_000);
                        this.warn(`setTargetState failed (${event.failureType}), retry ${attempt + 1}/${this.MAX_COMMAND_RETRIES} in ${delay / 1000}s`);
                        setTimeout(() => {
                            this.setTargetState(value, attempt + 1).catch(e => this.error('setTargetState retry failed:', e));
                        }, delay);
                    } else if (this.currentState) {
                        this.targetState?.updateValue(this.currentState.value);
                    }
                    break;
            }
        });
    }

    protected getTargetTemperatureCommands(value): Command | Array<Command> | undefined {
        return new Command('setTargetTemperature', value);
    }

    protected async setTargetTemperature(value, attempt = 0) {
        const action = await this.executeCommands(this.getTargetTemperatureCommands(value));
        action.on('update', (state, event) => {
            if (state === ExecutionState.FAILED) {
                if (attempt < this.MAX_COMMAND_RETRIES && this.isRetryable(event?.failureType)) {
                    const delay = Math.min(2 ** attempt * 1_000, 30_000);
                    this.warn(`setTargetTemperature failed (${event.failureType}), retry ${attempt + 1}/${this.MAX_COMMAND_RETRIES} in ${delay / 1000}s`);
                    setTimeout(() => {
                        this.setTargetTemperature(value, attempt + 1).catch(e => this.error('setTargetTemperature retry failed:', e));
                    }, delay);
                } else if (this.lastConfirmedTemperature !== undefined) {
                    this.warn('setTargetTemperature failed, reverting to', this.lastConfirmedTemperature);
                    this.targetTemperature?.updateValue(this.lastConfirmedTemperature);
                }
            }
        });
    }

    protected getOnCommands(value): Command | Array<Command> | undefined {
        return new Command('setOn', value);
    }

    protected async setOn(value) {
        const action = await this.executeCommands(this.getOnCommands(value));
        action.on('update', (state) => {
            switch (state) {
                case ExecutionState.FAILED:
                    this.on?.updateValue(!value);
                    break;
            }
        });
    }

    protected getProgCommands(): Command | Array<Command> | undefined {
        return this.getTargetStateCommands(this.targetState?.value);
    }

    protected sendProgCommands() {
        if (this.targetState?.value !== Characteristics.TargetHeatingCoolingState.OFF) {
            this.executeCommands(this.getProgCommands()).catch(e => this.error('sendProgCommands failed:', e));
        }
    }

    protected onTemperatureUpdate(value) {
        this.currentTemperature?.updateValue(value > 273.15 ? (value - 273.15) : value);
    }

    protected onStateChanged(name: string, value) {
        switch (name) {
            case 'core:TemperatureState': this.onTemperatureUpdate(value); break;
            case 'core:TargetTemperatureState':
                this.lastConfirmedTemperature = value;
                this.targetTemperature?.updateValue(value);
                break;
            case 'core:ElectricEnergyConsumptionState':
                this.consumption?.updateValue(value / 1000);
                break;
        }
    }
}
