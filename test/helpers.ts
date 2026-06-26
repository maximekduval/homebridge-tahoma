import { EventEmitter } from 'events';
import { vi } from 'vitest';

/**
 * Lightweight test doubles for the homebridge-tahoma plugin.
 *
 * The mappers only need a small slice of homebridge / overkiz-client, so rather
 * than pulling the real runtimes we model just enough surface to drive the
 * command + synchronisation logic under test.
 */

export class FakeLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
}

/** Mimics a homebridge Characteristic just enough for the mappers. */
export class FakeCharacteristic {
    public value: unknown;
    public props: Record<string, unknown> = {};
    public readonly updates: unknown[] = [];
    private setHandler?: (value: unknown) => unknown;
    private getHandler?: () => unknown;

    constructor(public readonly name: string, initial: unknown = 0) {
        this.value = initial;
    }

    updateValue(value: unknown) {
        this.value = value;
        this.updates.push(value);
        return this;
    }

    onSet(handler: (value: unknown) => unknown) {
        this.setHandler = handler;
        return this;
    }

    onGet(handler: () => unknown) {
        this.getHandler = handler;
        return this;
    }

    setProps(props: Record<string, unknown>) {
        Object.assign(this.props, props);
        return this;
    }

    /** Simulate HomeKit writing a value. */
    async emitSet(value: unknown) {
        return this.setHandler ? this.setHandler(value) : undefined;
    }

    /** Simulate HomeKit reading a value. */
    emitGet() {
        return this.getHandler ? this.getHandler() : this.value;
    }
}

export interface FakeDeviceOptions {
    label?: string;
    deviceURL?: string;
    uiClass?: string;
    widgetName?: string;
    states?: Record<string, unknown>;
    commands?: string[];
    parentStates?: Record<string, unknown>;
}

/** Mimics an overkiz-client Device. */
export class FakeDevice extends EventEmitter {
    label: string;
    deviceURL: string;
    definition: { uiClass: string; widgetName: string; commands: unknown[] };
    states: Array<{ name: string; value: unknown }>;
    sensors: FakeDevice[] = [];
    parent?: FakeDevice;
    private stateMap: Record<string, unknown>;
    private commandSet: Set<string>;

    constructor(opts: FakeDeviceOptions = {}) {
        super();
        this.label = opts.label ?? 'Test Device';
        this.deviceURL = opts.deviceURL ?? 'io://1234-5678-9012/1';
        this.definition = {
            uiClass: opts.uiClass ?? 'HeatingSystem',
            widgetName: opts.widgetName ?? 'HeatingSystem',
            commands: [],
        };
        this.stateMap = { ...(opts.states ?? {}) };
        this.states = Object.entries(this.stateMap).map(([name, value]) => ({ name, value }));
        this.commandSet = new Set(opts.commands ?? []);
        if (opts.parentStates) {
            this.parent = new FakeDevice({ states: opts.parentStates });
        }
    }

    hasState(name: string) {
        return name in this.stateMap;
    }

    hasCommand(name: string) {
        return this.commandSet.has(name);
    }

    hasSensor() {
        return false;
    }

    get(name: string) {
        return this.stateMap[name];
    }

    getNumber(name: string) {
        return Number(this.stateMap[name]);
    }

    set(name: string, value: unknown) {
        this.stateMap[name] = value;
    }
}

/** Mimics the plugin Platform. */
export class FakePlatform {
    log = new FakeLogger();
    config: Record<string, unknown> = {};
    devicesConfig: Record<string, unknown> = {};
    client = {
        hasExecution: vi.fn().mockReturnValue(false),
        cancelExecution: vi.fn().mockResolvedValue(undefined),
        refreshDeviceStates: vi.fn().mockResolvedValue(undefined),
    };

    /** Resolves with a fake execution id; tests can override. */
    executeAction = vi.fn().mockResolvedValue('exec-1');

    translate(label: string) {
        return label;
    }
}
