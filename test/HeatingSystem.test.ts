import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';

// The mappers reach for the module-level Characteristics/Services that the real
// Platform populates from homebridge's HAP at runtime. Provide just the enum
// constants the heating mappers read at construction / in computeStates.
vi.mock('../src/Platform', () => ({
    Characteristics: {
        TargetHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
        CurrentHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2 },
    },
    Services: {},
}));

import AtlanticZone from '../src/mappers/HeatingSystem/AtlanticPassAPCHeatingAndCoolingZone';
import HeatingSystem from '../src/mappers/HeatingSystem';
import WaterHeatingSystem from '../src/mappers/WaterHeatingSystem';
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

function makeZone(deviceOpts = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice({ uiClass: 'HeatingSystem', widgetName: 'AtlanticPassAPCHeatingAndCoolingZone', ...deviceOpts });
    const zone = new AtlanticZone(platform as any, {} as any, device as any) as any;
    zone.MIN_TEMP = 16;
    return { platform, device, zone };
}

function makeHeating(deviceOpts = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice(deviceOpts);
    const mapper = new HeatingSystem(platform as any, {} as any, device as any) as any;
    return { platform, device, mapper };
}

describe('AtlanticPassAPCHeatingAndCoolingZone.getHeatingCooling (C3)', () => {
    it('uses the parent operating mode when available (cooling)', () => {
        const { zone } = makeZone({ parentStates: { 'io:PassAPCOperatingModeState': 'cooling' } });
        expect(zone.getHeatingCooling()).toBe('Cooling');
    });

    it('follows the cooling side when the parent is dehumidifying', () => {
        const { zone, platform } = makeZone({ parentStates: { 'io:PassAPCOperatingModeState': 'drying' } });
        expect(zone.getHeatingCooling()).toBe('Cooling');
        expect(platform.log.warn).not.toHaveBeenCalled();
    });

    it('uses the parent operating mode when available (heating)', () => {
        const { zone } = makeZone({ parentStates: { 'io:PassAPCOperatingModeState': 'heating' } });
        expect(zone.getHeatingCooling()).toBe('Heating');
    });

    it('infers Cooling from the zone own states when the parent is absent', () => {
        const { zone } = makeZone({ states: { 'core:CoolingOnOffState': 'on', 'core:HeatingOnOffState': 'off' } });
        expect(zone.getHeatingCooling()).toBe('Cooling');
    });

    it('infers Heating from the zone own states when the parent is absent', () => {
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'on', 'core:CoolingOnOffState': 'off' } });
        expect(zone.getHeatingCooling()).toBe('Heating');
    });

    it('falls back to the mode the device exposes commands for', () => {
        const { zone } = makeZone({ commands: ['setCoolingOnOffState'] });
        expect(zone.getHeatingCooling()).toBe('Cooling');
    });

    it('defaults to Heating and warns only once when truly ambiguous', () => {
        const { zone, platform } = makeZone();
        expect(zone.getHeatingCooling()).toBe('Heating');
        expect(zone.getHeatingCooling()).toBe('Heating');
        expect(platform.log.warn).toHaveBeenCalledTimes(1);
    });
});

describe('AtlanticPassAPCHeatingAndCoolingZone.getProfile (O3)', () => {
    it('returns Eco when eco and target temperatures match within tolerance', () => {
        const { zone } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:EcoHeatingTargetTemperatureState': 17,
                'core:TargetTemperatureState': 17.2,
            },
        });
        expect(zone.getProfile()).toBe('Eco');
    });

    it('returns Comfort when eco and target temperatures differ', () => {
        const { zone } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:EcoHeatingTargetTemperatureState': 17,
                'core:TargetTemperatureState': 21,
            },
        });
        expect(zone.getProfile()).toBe('Comfort');
    });
});

describe('AtlanticPassAPCHeatingAndCoolingZone.getTargetTemperatureCommands', () => {
    it('uses derogation commands when prog is on and supported (HeatPump)', () => {
        const { zone } = makeZone({
            states: { 'core:HeatingOnOffState': 'on' },
            commands: ['setDerogatedTargetTemperature'],
        });
        zone.prog = { value: true };
        zone.derogationDuration = 2;
        const cmds = zone.getTargetTemperatureCommands(20);
        expect(cmds.map((c: any) => c.name)).toEqual([
            'setDerogatedTargetTemperature', 'setDerogationTime', 'setDerogationOnOffState',
        ]);
    });

    it('uses the zone-control command when prog is off and supported', () => {
        const { zone } = makeZone({
            states: { 'core:HeatingOnOffState': 'on' },
            commands: ['setHeatingTargetTemperature'],
        });
        zone.prog = { value: false };
        const cmd = zone.getTargetTemperatureCommands(20);
        expect(cmd.name).toBe('setHeatingTargetTemperature');
        expect(cmd.parameters).toEqual([20]);
    });

    it('falls back to the comfort command when prog is off and no direct command exists', () => {
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'on' } });
        zone.prog = { value: false };
        const cmd = zone.getTargetTemperatureCommands(20);
        expect(cmd.name).toBe('setComfortHeatingTargetTemperature');
    });
});

describe('AtlanticPassAPCHeatingAndCoolingZone.computeStates', () => {
    function withCharacteristics(zone: any) {
        zone.currentState = new FakeCharacteristic('CurrentHeatingCoolingState');
        zone.targetState = new FakeCharacteristic('TargetHeatingCoolingState');
        zone.targetTemperature = new FakeCharacteristic('TargetTemperature', 16);
        zone.currentTemperature = new FakeCharacteristic('CurrentTemperature', 18);
        zone.prog = new FakeCharacteristic('Prog', false);
    }

    it('reports OFF when the zone on/off state is off', () => {
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'off' } });
        withCharacteristics(zone);
        zone.computeStates();
        expect(zone.currentState.value).toBe(0); // CurrentHeatingCoolingState.OFF
        expect(zone.targetState.value).toBe(0); // TargetHeatingCoolingState.OFF
    });

    it('keeps the full mode set when the season is ambiguous (avoids HAP rejecting the turn-on write)', () => {
        // Regression: narrowing on a guess shrank validValues to the wrong season.
        // While the zone is off with no parent / no commands, getOperatingMode() is
        // undefined, so we must keep [OFF, HEAT, COOL] — otherwise HomeKit caches a
        // now-invalid value and the next "turn on" tap is rejected by HAP before
        // onSet (No Response, no log).
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'off' } });
        withCharacteristics(zone);
        zone.targetState.setProps({ validValues: [0, 1, 2] }); // OFF, HEAT, COOL
        zone.computeStates();
        expect(zone.targetState.props.validValues).toEqual([0, 1, 2]);
    });

    it('narrows the offered modes to OFF + COOL when cooling AND running', () => {
        const { zone } = makeZone({
            parentStates: { 'io:PassAPCOperatingModeState': 'cooling' },
            states: { 'core:CoolingOnOffState': 'on' },
        });
        withCharacteristics(zone);
        zone.targetState.setProps({ validValues: [0, 1, 2] });
        zone.computeStates();
        expect(zone.targetState.props.validValues).toEqual([0, 2]); // OFF, COOL
    });

    it('narrows the offered modes to OFF + HEAT when heating AND running', () => {
        const { zone } = makeZone({
            parentStates: { 'io:PassAPCOperatingModeState': 'heating' },
            states: { 'core:HeatingOnOffState': 'on' },
        });
        withCharacteristics(zone);
        zone.targetState.setProps({ validValues: [0, 1, 2] });
        zone.computeStates();
        expect(zone.targetState.props.validValues).toEqual([0, 1]); // OFF, HEAT
    });

    it('keeps the full set while the zone is OFF even when the season is known (activation from off must work)', () => {
        // Regression of the "No Response when tapping the number to activate" bug:
        // narrowing while off made HomeKit's turn-on write fall outside validValues,
        // rejected by HAP before onSet. While off we must publish [OFF, HEAT, COOL].
        const { zone } = makeZone({
            parentStates: { 'io:PassAPCOperatingModeState': 'heating' },
            states: { 'core:HeatingOnOffState': 'off' },
        });
        withCharacteristics(zone);
        zone.targetState.setProps({ validValues: [0, 1] }); // pretend a stale narrowed set
        zone.computeStates();
        expect(zone.targetState.props.validValues).toEqual([0, 1, 2]); // OFF, HEAT, COOL
    });

    it('reports HEAT and applies the confirmed target temperature when heating and idle', () => {
        const { zone } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:HeatingTargetTemperatureState': 21,
            },
        });
        withCharacteristics(zone);
        zone.currentTemperature.value = 19; // below target -> actively heating
        zone.computeStates();
        expect(zone.targetState.value).toBe(1); // HEAT
        expect(zone.currentState.value).toBe(1); // HEAT
        expect(zone.targetTemperature.value).toBe(21);
        expect(zone.lastConfirmedTemperature).toBe(21);
    });

    it('reflects internalScheduling as prog enabled', () => {
        const { zone } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:HeatingTargetTemperatureState': 20,
                'io:PassAPCHeatingModeState': 'internalScheduling',
            },
        });
        withCharacteristics(zone);
        zone.computeStates();
        expect(zone.prog.value).toBe(true);
    });

    it('does not overwrite the target temperature while a command is in flight', () => {
        const { zone, platform } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:HeatingTargetTemperatureState': 21,
            },
        });
        withCharacteristics(zone);
        zone.targetTemperature.value = 23; // value the user just set
        // Simulate an in-flight command (C2): isIdle must be false.
        platform.client.hasExecution.mockReturnValue(true);
        zone.computeStates();
        expect(zone.targetTemperature.value).toBe(23); // not clobbered by stale echo
    });
});

describe('setTargetTemperature while the zone is off', () => {
    function withCharacteristics(mapper: any, targetState: number) {
        mapper.targetState = new FakeCharacteristic('TargetHeatingCoolingState', targetState);
        mapper.targetTemperature = new FakeCharacteristic('TargetTemperature', 23);
        mapper.lastConfirmedTemperature = 19;
    }

    it('drops the setpoint a HomeKit scene writes along with OFF, and shows the real one again', async () => {
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'off' } });
        withCharacteristics(zone, 0); // OFF
        const execute = vi.spyOn(zone, 'executeCommands').mockResolvedValue(new EventEmitter() as any);

        await zone.setTargetTemperature(23);

        expect(execute).not.toHaveBeenCalled();
        expect(zone.targetTemperature.value).toBe(19);
    });

    it('still sends the setpoint when the zone is turned on', async () => {
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'on' } });
        withCharacteristics(zone, 1); // HEAT
        zone.prog = { value: false };
        const execute = vi.spyOn(zone, 'executeCommands').mockResolvedValue(new EventEmitter() as any);

        await zone.setTargetTemperature(21);

        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('keeps sending it for mappers that did not opt in', async () => {
        const { mapper } = makeHeating();
        withCharacteristics(mapper, 0); // OFF
        const execute = vi.spyOn(mapper, 'executeCommands').mockResolvedValue(new EventEmitter() as any);

        await mapper.setTargetTemperature(21);

        expect(execute).toHaveBeenCalledTimes(1);
    });
});

describe('HeatingSystem (base) commands', () => {
    it('maps target states to mode commands', () => {
        const { mapper } = makeHeating();
        const C = { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 };
        expect(mapper.getTargetStateCommands(C.AUTO).name).toBe('auto');
        expect(mapper.getTargetStateCommands(C.HEAT).name).toBe('heat');
        expect(mapper.getTargetStateCommands(C.COOL).name).toBe('cool');
        expect(mapper.getTargetStateCommands(C.OFF).name).toBe('off');
    });

    it('builds setTargetTemperature and setOn commands', () => {
        const { mapper } = makeHeating();
        const t = mapper.getTargetTemperatureCommands(19.5);
        expect(t.name).toBe('setTargetTemperature');
        expect(t.parameters).toEqual([19.5]);
        expect(mapper.getOnCommands(true).name).toBe('setOn');
    });
});

describe('HeatingSystem.isRetryable', () => {
    it('retries transient transport failures', () => {
        const { mapper } = makeHeating();
        expect(mapper.isRetryable('DATA_TRANSPORT_SERVICE_ERROR')).toBe(true);
        expect(mapper.isRetryable('DATA_TRANSPORT_SERVICE_ABORTED_BY_RECIPIENT')).toBe(true);
    });

    it('retries DEVICE_DEFECT (device not ready, e.g. just switched on from off)', () => {
        const { mapper } = makeHeating();
        expect(mapper.isRetryable('DEVICE_DEFECT')).toBe(true);
    });

    it('retries PEER_DOWN (box cannot reach the device for a moment)', () => {
        const { mapper } = makeHeating();
        expect(mapper.isRetryable('PEER_DOWN')).toBe(true);
    });

    it('retries TIME_OUT_ON_TRANSMITTED_COMMAND (sent but never acknowledged)', () => {
        const { mapper } = makeHeating();
        expect(mapper.isRetryable('TIME_OUT_ON_TRANSMITTED_COMMAND')).toBe(true);
    });

    it('re-sends an on/off command that failed with PEER_DOWN, then stops on success', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            const first = new EventEmitter();
            const second = new EventEmitter();
            const execute = vi.spyOn(mapper, 'executeCommands')
                .mockResolvedValueOnce(first as any)
                .mockResolvedValueOnce(second as any);

            await mapper.setTargetState(0); // OFF
            first.emit('update', 'FAILED', { failureType: 'PEER_DOWN' });
            expect(execute).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1_000);
            expect(execute).toHaveBeenCalledTimes(2);

            second.emit('update', 'COMPLETED', {});
            await vi.advanceTimersByTimeAsync(60_000);
            expect(execute).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not retry unknown / permanent failures or a missing failure type', () => {
        const { mapper } = makeHeating();
        expect(mapper.isRetryable('CANCELLED')).toBe(false);
        expect(mapper.isRetryable(undefined)).toBe(false);
    });
});

describe('HeatingSystem — a newer command replaces a pending retry', () => {
    /** Every executeCommands call gets its own action, so a test can fail them one by one. */
    function mockExecutions(mapper: any) {
        const actions: EventEmitter[] = [];
        const execute = vi.spyOn(mapper, 'executeCommands').mockImplementation(async () => {
            const action = new EventEmitter();
            actions.push(action);
            return action as any;
        });
        const sent = () => execute.mock.calls.map((call: any[]) => call[0].name);
        return { actions, execute, sent };
    }

    it('does not re-send an old mode after the user chose another one', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            const { actions, sent } = mockExecutions(mapper);

            await mapper.setTargetState(0); // Off
            actions[0].emit('update', 'FAILED', { failureType: 'PEER_DOWN' }); // retry planned in 1 s
            await mapper.setTargetState(1); // Heat, before the retry
            await vi.advanceTimersByTimeAsync(60_000);

            expect(sent()).toEqual(['off', 'heat']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops retrying an old mode that was replaced while its retry was running', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            const { actions, sent } = mockExecutions(mapper);

            await mapper.setTargetState(0); // Off
            actions[0].emit('update', 'FAILED', { failureType: 'PEER_DOWN' });
            await vi.advanceTimersByTimeAsync(1_000); // the retry of Off goes out
            await mapper.setTargetState(1); // Heat, while that retry is running
            actions[1].emit('update', 'FAILED', { failureType: 'PEER_DOWN' }); // the old Off fails again
            await vi.advanceTimersByTimeAsync(60_000);

            expect(sent()).toEqual(['off', 'off', 'heat']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not put the UI back to the old mode when the replaced command fails for good', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            mapper.currentState = new FakeCharacteristic('CurrentHeatingCoolingState', 0);
            mapper.targetState = new FakeCharacteristic('TargetHeatingCoolingState', 1);
            const { actions } = mockExecutions(mapper);

            await mapper.setTargetState(0); // Off
            await mapper.setTargetState(1); // Heat replaces it
            actions[0].emit('update', 'FAILED', { failureType: 'CANCELLED' });

            expect(mapper.targetState.updates).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still puts the UI back when the latest command fails for good', async () => {
        const { mapper } = makeHeating();
        mapper.currentState = new FakeCharacteristic('CurrentHeatingCoolingState', 0);
        mapper.targetState = new FakeCharacteristic('TargetHeatingCoolingState', 1);
        const { actions } = mockExecutions(mapper);

        await mapper.setTargetState(1);
        actions[0].emit('update', 'FAILED', { failureType: 'CANCELLED' });

        expect(mapper.targetState.updates).toEqual([0]);
    });

    it('keeps the retry of a mode when only the setpoint changes', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            const { actions, sent } = mockExecutions(mapper);

            await mapper.setTargetState(0); // Off
            actions[0].emit('update', 'FAILED', { failureType: 'PEER_DOWN' });
            await mapper.setTargetTemperature(21); // another kind of command
            await vi.advanceTimersByTimeAsync(1_000);

            expect(sent()).toEqual(['off', 'setTargetTemperature', 'off']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not re-send an old setpoint after a newer one', async () => {
        vi.useFakeTimers();
        try {
            const { mapper } = makeHeating();
            const { actions, execute } = mockExecutions(mapper);

            await mapper.setTargetTemperature(20);
            actions[0].emit('update', 'FAILED', { failureType: 'DEVICE_DEFECT' }); // retry planned in 1 s
            await mapper.setTargetTemperature(21);
            await vi.advanceTimersByTimeAsync(60_000);

            expect(execute).toHaveBeenCalledTimes(2);
            expect((execute.mock.calls[1] as any[])[0].parameters).toEqual([21]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not put the UI back when a replaced setpoint fails for good', async () => {
        const { mapper } = makeHeating();
        mapper.lastConfirmedTemperature = 19;
        mapper.targetTemperature = new FakeCharacteristic('TargetTemperature', 21);
        const { actions } = mockExecutions(mapper);

        await mapper.setTargetTemperature(20);
        await mapper.setTargetTemperature(21);
        actions[0].emit('update', 'FAILED', { failureType: 'CANCELLED' });

        expect(mapper.targetTemperature.updates).toEqual([]);
    });
});

describe('HeatingSystem (base) onStateChanged', () => {
    it('converts a Kelvin temperature to Celsius', () => {
        const { mapper } = makeHeating();
        mapper.currentTemperature = new FakeCharacteristic('CurrentTemperature', 0);
        mapper.onStateChanged('core:TemperatureState', 293.15);
        expect(mapper.currentTemperature.value).toBeCloseTo(20, 5);
    });

    it('passes a Celsius temperature through unchanged', () => {
        const { mapper } = makeHeating();
        mapper.currentTemperature = new FakeCharacteristic('CurrentTemperature', 0);
        mapper.onStateChanged('core:TemperatureState', 20);
        expect(mapper.currentTemperature.value).toBe(20);
    });

    it('records the confirmed target temperature', () => {
        const { mapper } = makeHeating();
        mapper.targetTemperature = new FakeCharacteristic('TargetTemperature', 0);
        mapper.onStateChanged('core:TargetTemperatureState', 21);
        expect(mapper.targetTemperature.value).toBe(21);
        expect(mapper.lastConfirmedTemperature).toBe(21);
    });

    it('converts electric energy consumption from Wh to kWh', () => {
        const { mapper } = makeHeating();
        mapper.consumption = new FakeCharacteristic('TotalConsumption', 0);
        mapper.onStateChanged('core:ElectricEnergyConsumptionState', 2500);
        expect(mapper.consumption.value).toBe(2.5);
    });
});

describe('WaterHeatingSystem', () => {
    it('uses the DHW temperature range', () => {
        const platform = new FakePlatform();
        const device = new FakeDevice({ uiClass: 'WaterHeatingSystem', widgetName: 'WaterHeatingSystem' });
        const mapper = new WaterHeatingSystem(platform as any, {} as any, device as any) as any;
        expect(mapper.MIN_TEMP).toBe(40);
        expect(mapper.MAX_TEMP).toBe(65);
    });
});
