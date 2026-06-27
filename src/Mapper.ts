import { Characteristics, Services } from './Platform';
import { CharacteristicValue, HAPStatus, Logger, PlatformAccessory, Service } from 'homebridge';
import { Device, State, Command, Action, ExecutionState } from 'overkiz-client';
import { Platform } from './Platform';
import { GREY } from './colors';

export default abstract class Mapper {
    protected log: Logger;
    private postponeTimer;
    private debounceTimer;
    protected stateless = false;
    private executionId;
    private actionPromise;
    // Number of commands/executions started by this mapper that have not yet
    // reached a terminal state. Tracked synchronously so `isIdle` is reliable
    // during the batch + execution window (avoids stale server echoes
    // overwriting a value the user just set).
    private inFlight = 0;
    protected expectedStates: Array<string> = [];

    constructor(
        protected readonly platform: Platform,
        protected readonly accessory: PlatformAccessory,
        protected readonly device: Device,
    ) {
        this.log = this.platform.log;
    }

    public build() {
        const config = Object.assign({},
            this.platform.devicesConfig[this.device.definition.uiClass],
            this.platform.devicesConfig[this.device.definition.widgetName],
            this.platform.devicesConfig[this.device.label],
            this.platform.devicesConfig[this.device.uuid],
        );
        this.stateless = this.device.states.length === 0 ||
            (this.expectedStates.length > 0 && !this.expectedStates.some((state) => this.device.hasState(state)));
        this.applyConfig(config);
        if (Object.keys(config).length > 0) {
            delete config.key;
            if (this.platform.config.debug) {
                this.log.info(`${GREY}  Config: `, JSON.stringify(config));
            } else {
                this.log.debug('  Config: ', JSON.stringify(config));
            }
        }

        const services = this.registerServices();

        const info = this.accessory.getService(Services.AccessoryInformation);
        if (info) {
            info.setCharacteristic(Characteristics.Manufacturer, this.device.manufacturer);
            info.setCharacteristic(Characteristics.Model, this.device.model);
            info.setCharacteristic(Characteristics.SerialNumber, this.device.address.substring(0, 64));
            services.push(info);
        }

        this.accessory.services.forEach((service) => {
            if (!services.find((s) => s.UUID === service.UUID && s.subtype === service.subtype)) {
                this.accessory.removeService(service);
            }
        });

        if (!this.stateless) {
            // Init and register states changes
            this.onStatesChanged(this.device.states, true);
            this.device.on('states', states => this.onStatesChanged(states));

            // Init and register sensors states changes
            this.device.sensors.forEach((sensor) => {
                this.onStatesChanged(sensor.states, true);
                sensor.on('states', states => this.onStatesChanged(states));
            });
        }

        // TODO: instanciate mapper for device sensors
        // Configure accessory sensors
        // this.device.sensors.forEach((sensor) => new mapper(platform, accessory, sensor)))
    }

    /**
     * Helper methods
     */
    protected applyConfig(config) {
        //
    }

    protected registerService(type: any, subtype?: string): Service {
        let service: Service;
        const name = subtype ? this.translate(subtype) : this.device.label;
        if (subtype) {
            service = this.accessory.getServiceById(type, subtype) || this.accessory.addService(type, name, subtype);
        } else {
            service = this.accessory.getService(type) || this.accessory.addService(type);
        }
        service.setCharacteristic(Characteristics.Name, name);
        return service;
    }

    private translate(value: string) {
        switch (value) {
            case 'boost': return 'Boost';
            case 'drying': return 'Séchage';
            default: return value.charAt(0).toUpperCase() + value.slice(1);
        }
    }

    protected debounce(task, immediate: Array<CharacteristicValue> = []) {
        return async (value: CharacteristicValue) => {
            if (this.debounceTimer !== null) {
                clearTimeout(this.debounceTimer);
            }
            if (immediate.includes(value)) {
                await task.bind(this, value)();
            } else {
                this.debounceTimer = setTimeout(async () => {
                    this.debounceTimer = null;
                    task.bind(this, value)().catch((err) => this.error('Command failed:', err));
                }, 500);
            }
        };
    }

    protected postpone(task, ...args) {
        if (this.postponeTimer !== null) {
            clearTimeout(this.postponeTimer);
        }
        this.postponeTimer = setTimeout(() => {
            this.postponeTimer = null;
            task.bind(this, ...args)();
        }, 500);
    }

    protected async executeCommands(commands: Command | Array<Command> | undefined, standalone = false): Promise<Action> {
        if (commands === undefined || (Array.isArray(commands) && commands.length === 0)) {
            this.error('No target command for', this.device.label);
            throw HAPStatus.RESOURCE_DOES_NOT_EXIST;
        }
        const commandList = Array.isArray(commands) ? commands : [commands];
        for (const c of commandList) {
            this.info(c.name + JSON.stringify(c.parameters));
        }

        const commandName = commandList[0].name;
        const localizedName = this.platform.translate(
            commandName + (commandList[0].parameters.length > 0 ? '.' + commandList[0].parameters[0] : ''),
        );

        const highPriority = this.device.hasState('io:PriorityLockLevelState') ? true : false;
        const label = this.device.label + ' - ' + localizedName;

        if (this.actionPromise) {
            // Within the batch window: merge into the pending action. We do this
            // here rather than via Action.addCommands(), which has a bug
            // (iterates the existing commands instead of the new ones) that
            // silently drops a second distinct command for the same device.
            this.mergeCommands(this.actionPromise.action, commandList);
        } else {
            this.inFlight++;
            this.actionPromise = new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        this.executionId = await this.platform.executeAction(label, this.actionPromise.action, highPriority, standalone);
                        resolve(this.actionPromise.action);
                    } catch (error: any) {
                        // The execution never started, so no terminal event will
                        // arrive to release the in-flight slot: release it here.
                        this.inFlight = Math.max(0, this.inFlight - 1);
                        this.error(commandName + ' ' + error.message);
                        reject(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    }
                    this.actionPromise = null;
                }, 100);

            });
            const action = new Action(this.device.deviceURL, commandList);
            // Each caller attaches its own per-concern 'update' listener; allow
            // an unbounded count so batched callers don't trip the EventEmitter
            // leak warning.
            action.setMaxListeners(0);
            this.actionPromise.action = action;
            let settled = false;
            // Safety net: if the gateway connection drops mid-execution and no
            // terminal event ever arrives, release the in-flight guard so the
            // mapper can re-sync instead of being stuck "busy" forever. The
            // overkiz-client EXEC_TIMEOUT also emits TIMED_OUT eventually, so
            // this is belt-and-suspenders.
            let safetyTimer: ReturnType<typeof setTimeout> | null = null;
            action.on('update', (state, event) => {
                // Overkiz marks a truly final transition with timeToNextState === -1.
                // NOT_TRANSMITTED is NOT a failure: it is an intermediate step of the
                // lifecycle (INITIALIZED → NOT_TRANSMITTED → TRANSMITTED → IN_PROGRESS
                // → COMPLETED/FAILED) meaning "not yet transmitted to the device". It
                // is emitted on almost every command and is usually followed by
                // COMPLETED, so we log it at debug — not warn.
                const terminal = this.isTerminalState(state) || event?.timeToNextState === -1;

                if (state === ExecutionState.FAILED) {
                    this.error(commandName, event?.failureType);
                } else if (state === ExecutionState.COMPLETED) {
                    this.info(commandName, state);
                } else if (state === ExecutionState.TIMED_OUT) {
                    this.warn(commandName, state);
                } else {
                    // INITIALIZED / NOT_TRANSMITTED / TRANSMITTED / IN_PROGRESS — transient.
                    this.debug(commandName, state);
                }

                if (settled) {
                    return;
                }
                if (terminal) {
                    if (safetyTimer !== null) {
                        clearTimeout(safetyTimer);
                        safetyTimer = null;
                    }
                    settled = true;
                    this.inFlight = Math.max(0, this.inFlight - 1);
                } else if (safetyTimer === null) {
                    safetyTimer = setTimeout(() => {
                        if (!settled) {
                            settled = true;
                            this.inFlight = Math.max(0, this.inFlight - 1);
                            this.debug(commandName, 'no terminal event from gateway, releasing in-flight guard');
                        }
                    }, 60_000);
                }
            });
        }
        return this.actionPromise;
    }

    private isTerminalState(state): boolean {
        // NOT_TRANSMITTED is intentionally absent: it is a transient lifecycle
        // step, not a terminal state (see the 'update' handler in executeCommands).
        return state === ExecutionState.COMPLETED ||
            state === ExecutionState.FAILED ||
            state === ExecutionState.TIMED_OUT;
    }

    /**
     * Merge new commands into a pending action, replacing parameters of a
     * command already queued with the same name (latest value wins) or
     * appending it otherwise.
     */
    private mergeCommands(action: Action, commands: Array<Command>) {
        for (const command of commands) {
            const existing = action.commands.find((c) => c.name === command.name);
            if (existing) {
                existing.parameters = command.parameters;
            } else {
                action.commands.push(command);
            }
        }
    }

    private async delay(duration) {
        return new Promise(resolve => setTimeout(resolve, duration));
    }

    protected async requestStatesUpdate(defer?: number) {
        if (defer) {
            await this.delay(defer * 1000);
        }
        await this.platform.client.refreshDeviceStates(this.device.deviceURL);
    }

    /**
     * Logging methods
     */

    protected debug(...args) {
        if (this.platform.config.debug) {
            this.platform.log.info(`${GREY}[${this.device.label}]`, ...args);
        } else {
            this.platform.log.debug(`[${this.device.label}]`, ...args);
        }
    }

    protected info(...args) {
        this.platform.log.info(`[${this.device.label}]`, ...args);
    }

    protected warn(...args) {
        this.platform.log.warn(`[${this.device.label}]`, ...args);
    }

    protected error(...args) {
        this.platform.log.error(`[${this.device.label}]`, ...args);
    }

    protected registerServices(): Array<Service> {
        if (typeof this.registerMainService === 'function') {
            try {
                return [this.registerMainService()];
            } catch (error: any) {
                this.log.warn(error.message);
            }
        } else {
            this.log.warn(this.device.definition.widgetName + ' not supported.');
        }
        return [];
    }

    protected onStatesChanged(states: Array<State>, init = false) {
        states.forEach((state: State) => {
            if (!init) {
                this.debug(state.name + ' => ' + state.value);
            }
            if (typeof this.onStateChanged === 'function') {
                this.onStateChanged(state.name, state.value);
            }
        });
    }

    get isIdle() {
        // Idle only when this mapper has no command being batched/executed AND
        // the last tracked execution has left the client pool. The in-flight
        // counter closes the window between issuing a command and the execId
        // becoming known, during which the pool check alone would wrongly
        // report idle and let a stale state echo overwrite the new value.
        return this.inFlight === 0 && !this.platform.client.hasExecution(this.executionId);
    }

    async cancelExecution() {
        await this.platform.client.cancelExecution(this.executionId);
    }

    /**
     * Abstract methods to be implemented
     */

    /**
     * Build the main device service
     * @return the main service
     */
    protected abstract registerMainService(): Service;

    /**
     * Triggered when device state change
     * @param name State name
     * @param value State value
     */
    protected abstract onStateChanged(name: string, value);
}
