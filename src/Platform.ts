import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Client, Execution, Action } from 'overkiz-client';
import Mapper from './Mapper';
import SceneMapper from './SceneMapper';
import { CustomCharacteristics } from './CustomCharacteristics';
import { BLUE, GREY, RESET } from './colors';


export let Services: typeof Service;
export let Characteristics: typeof Characteristic;

const DEFAULT_RETRY_DELAY = 60;
// Cap the exponential backoff used when device discovery fails so the retry
// interval cannot grow without bound.
const MAX_RETRY_DELAY = 600;

// Sentinel handed to overkiz-client to disable the periodic full-state refresh
// when the user sets refreshPeriod: 0.
//
// overkiz cannot take a plain 0 (it computes `(config.refreshPeriod || 30)`, so
// 0 falls back to 30). A huge *positive* value is actively dangerous: overkiz
// feeds `minutes * 60 * 1000` to setInterval, and Node clamps any delay above
// its 32-bit limit (2_147_483_647 ms ≈ 24.8 days) down to 1 ms — firing the
// refresh ~1000×/s and instantly exhausting Somfy's quota (the old
// REFRESH_DISABLED_MINUTES = 5_000_000 did exactly this).
//
// A negative value sidesteps both traps: overkiz computes a non-positive period
// and its setRefreshTaskPeriod only arms an interval when `period > 0`, so the
// refresh task is never scheduled at all — truly disabled, no overflow.
const REFRESH_DISABLED_SENTINEL = -1;

/**
 * Translate the user-facing `refreshPeriod` (0 = disable the periodic full-state
 * refresh) into the value handed to overkiz-client. Any non-zero value is passed
 * through untouched; an explicit 0 becomes the disable sentinel.
 */
export function resolveRefreshPeriod(value: unknown): unknown {
    return value === 0 ? REFRESH_DISABLED_SENTINEL : value;
}

/**
 * Whether to force a one-shot full-state refresh right after startup.
 *
 * getDevices() only seeds HomeKit from the cloud's stored snapshot, which can be
 * stale for changes made outside HomeKit (e.g. a setpoint set on a heat-pump's
 * physical remote). A startup refresh makes a restart reflect the real state
 * immediately instead of waiting up to a full refreshPeriod. It is skipped when
 * the user opted out of the periodic refresh (refreshPeriod: 0 → sentinel), so
 * disabling the refresh stays a true opt-out. `resolvedRefreshPeriod` is the
 * value already passed through resolveRefreshPeriod.
 */
export function shouldRefreshOnStartup(resolvedRefreshPeriod: unknown): boolean {
    return resolvedRefreshPeriod !== REFRESH_DISABLED_SENTINEL;
}

// Process-wide error handlers must be installed only once, even if several
// platform instances are configured (e.g. multiple TaHoma accounts), otherwise
// each instance adds its own listener and Node warns about a leak.
let processHandlersInstalled = false;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class Platform implements DynamicPlatformPlugin {
    // this is used to track restored cached accessories
    private readonly accessories: PlatformAccessory[] = [];
    public readonly client: Client;

    private readonly exclude: Array<string>;
    private readonly exposeScenarios: boolean | Array<string>;
    public readonly devicesConfig: Array<unknown> = [];

    private translations;
    private executionPromise;
    private retryDelay = DEFAULT_RETRY_DELAY;

    constructor(public readonly log: Logger, public readonly config: PlatformConfig, public readonly api: API) {
        Services = this.api.hap.Service;
        Characteristics = this.api.hap.Characteristic;
        new CustomCharacteristics(this.api.hap);
        this.log.debug('Finished initializing platform:', this.config.name);

        if (!processHandlersInstalled) {
            processHandlersInstalled = true;
            process.on('unhandledRejection', (error: any) => this.log.error('Unhandled rejection:', error));
            process.on('uncaughtException', (error: any) => this.log.error('Uncaught exception:', error));
        }

        this.exclude = config.exclude || [];
        this.exclude.push('Pod', 'ConfigurationComponent', 'NetworkComponent', 'ProtocolGateway', 'ConsumptionSensor',
            'OnOffHeatingSystem', 'Wifi', 'RemoteController',
            // AtlanticElectricalTowelDryer bad sensors
            'io:LightIOSystemDeviceSensor', 'io:RelativeHumidityIOSystemDeviceSensor', 'WeatherForecastSensor',
        );
        this.exposeScenarios = config.exposeScenarios;
        config.devicesConfig?.forEach(x => this.devicesConfig[x.key] = x);

        const logger = Object.assign({}, log, {
            debug: (...args) => {
                if (config['debug']) {
                    log.info('\x1b[90m', ...args);
                } else {
                    log.debug(args.shift(), ...args);
                }
            },
        });

        // The periodic full-state refresh (refreshPeriod) POSTs to Somfy's
        // /setup/devices/states/refresh, a heavily rate-limited endpoint — too
        // frequent and the cloud answers "429 QUOTA_EXCEEDED". It forces the box
        // to re-declare every state, which is the ONLY way to catch changes the
        // box does not stream through event polling: one-way RTS devices, but
        // also some io/cloud changes — notably a setpoint set on an Atlantic
        // heat-pump's physical room remote, which never emits a
        // DeviceStateChangedEvent. With refreshPeriod: 0 such a change never
        // reaches HomeKit (even a restart only re-reads the same stale cloud
        // snapshot, since getDevices() does not force a refresh), so disabling it
        // is only safe with no RTS devices and no such local controls. See
        // resolveRefreshPeriod for why a plain 0 cannot reach overkiz unchanged.
        if (config['refreshPeriod'] === 0) {
            this.log.warn('Refresh period set to 0: periodic full-state refresh disabled. '
                + 'Changes made outside HomeKit (RTS devices, or a setpoint set on a physical remote) '
                + 'may not appear in HomeKit until you re-enable it.');
        }
        config['refreshPeriod'] = resolveRefreshPeriod(config['refreshPeriod']);

        this.client = new Client(logger, config);

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            // run the method to discover / register your devices as accessories
            this.discoverDevices();
            if (this.config['service'] !== 'local') {
                this.loadLocation();
            }
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    async loadLocation() {
        let countryCode = 'en';
        const location = await this.client.getSetupLocation().catch((error) => this.log.warn('Fail to load lang file:', error));
        if (location?.countryCode) {
            countryCode = location.countryCode.toLowerCase().trim();
        }
        this.translations = await import(`./lang/${countryCode}.json`)
            .catch(() => import('./lang/en.json'))
            .then((c) => c.default);

    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    async configureAccessory(accessory: PlatformAccessory) {
        if (!this.accessories.map((a) => a.UUID).includes(accessory.UUID)) {
            this.accessories.push(accessory);
        }
    }

    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
        try {
            const uuids = Array<string>();
            const devices = await this.client.getDevices();
            this.log.debug(devices.length + ' devices discovered');

            // loop over the discovered devices and register each one if it has not already been registered
            for (const device of devices) {
                if (
                    this.exclude.includes(device.definition.uiClass) ||
                    this.exclude.includes(device.definition.widgetName) ||
                    this.exclude.includes(device.controllableName) ||
                    this.exclude.includes(device.label) ||
                    this.exclude.includes(device.protocol)
                ) {
                    continue;
                }

                // Reuse the cached accessory restored in `configureAccessory`, or
                // create it if this device is new. Service reconciliation for an
                // existing accessory is handled by the mapper's build() below.
                let accessory = this.accessories.find(accessory => accessory.UUID === device.uuid);

                if (!accessory) {
                    this.log.info('Create accessory:', device.label);
                    accessory = new this.api.platformAccessory(device.label, device.uuid);
                    await this.configureAccessory(accessory);
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }

                this.log.info(`Configure device ${BLUE}${accessory.displayName}${RESET}`);
                this.log.info(`${GREY}  ${device.definition.uiClass} > ${device.definition.widgetName}`);

                const mapper = await import(`./mappers/${device.definition.uiClass}/${device.definition.widgetName}/${device.uniqueName}`)
                    .catch(() => import(`./mappers/${device.definition.uiClass}/${device.definition.widgetName}`))
                    .catch(() => import(`./mappers/${device.definition.uiClass}`))
                    .then((c) => c.default)
                    .catch(() => Mapper);
                new mapper(this, accessory, device).build();

                uuids.push(device.uuid);
            }


            if (this.exposeScenarios) {
                const actionGroups = await this.client.getActionGroups();

                for (const actionGroup of actionGroups) {
                    if (this.exclude.includes(actionGroup.label) || actionGroup.label.startsWith('internal:') || actionGroup.label === '') {
                        continue;
                    }

                    let accessory = this.accessories.find(accessory => accessory.UUID === actionGroup.oid);

                    if (!accessory) {
                        // the accessory does not yet exist, so we need to create it
                        this.log.info('Create accessory', actionGroup.label);
                        accessory = new this.api.platformAccessory(actionGroup.label, actionGroup.oid);
                        await this.configureAccessory(accessory);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    }

                    this.log.info('Map scene', accessory.displayName);

                    new SceneMapper(this, accessory, actionGroup);
                    uuids.push(actionGroup.oid);
                }
            }

            const deleted = this.accessories.filter((accessory) => !uuids.includes(accessory.UUID));
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, deleted);
            this.retryDelay = DEFAULT_RETRY_DELAY;

            // Devices are now registered and their states seeded from the cloud
            // snapshot returned by getDevices(). That snapshot can be stale for
            // changes made outside HomeKit (e.g. a setpoint set on an Atlantic
            // heat-pump's physical room remote, which the box never streams
            // through event polling). The scheduled refresh task is armed but
            // does not fire until a full refreshPeriod elapses (default 30 min),
            // so without this a restart would not pick such changes up. Force one
            // full-state refresh now so a restart reflects the real state right
            // away. Best-effort: a failure here must not abort startup, and it is
            // skipped when the periodic refresh is disabled to honour the opt-out.
            if (shouldRefreshOnStartup(this.config['refreshPeriod'])) {
                this.client.refreshAllStates().catch((error: any) =>
                    this.log.debug('Initial state refresh failed:', error?.message ?? error));
            }
        } catch (error: any) {
            this.log.error(error);
            this.log.error('Retry in ' + this.retryDelay + ' sec...');
            setTimeout(this.discoverDevices.bind(this), this.retryDelay * 1000);
            this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
        }
    }

    /*
        action: The action to execute
    */
    public executeAction(label: string, action: Action, highPriority = false, standalone = false) {
        if (standalone) {
            // Run action in standalone execution
            return this.client.execute(highPriority ? 'apply/highPriority' : 'apply', new Execution(label + ' - HomeKit', action));
        } else {
            if (this.executionPromise) {
                this.executionPromise.execution.addAction(action);
                this.executionPromise.execution.label = 'Execute scene (' +
                    this.executionPromise.execution.actions.length + ' devices) - HomeKit';
            } else {
                this.executionPromise = new Promise((resolve, reject) => {
                    setTimeout(() => {
                        this.client.execute(highPriority ? 'apply/highPriority' : 'apply', this.executionPromise.execution)
                            .then(resolve)
                            .catch(reject);
                        this.executionPromise = null;
                    }, 100);
                });
                this.executionPromise.execution = new Execution(label + ' - HomeKit', action);
            }
            return this.executionPromise;
        }
    }

    /**
     * Translate
     * @param path 
     * @returns string
     */
    public translate(label: string): string | null {
        const path = label.split('.');
        let translation = this.translations;
        for (const key of path) {
            if (typeof translation === 'object' && key in translation) {
                translation = translation[key];
            } else if (typeof translation === 'string') {
                if (translation.includes(':param')) {
                    translation = translation.replace(':param', key);
                }
                return translation;
            }
        }
        return label;
    }
}
