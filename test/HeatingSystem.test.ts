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
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

function makeZone(deviceOpts = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice({ uiClass: 'HeatingSystem', widgetName: 'AtlanticPassAPCHeatingAndCoolingZone', ...deviceOpts });
    const zone = new AtlanticZone(platform as any, {} as any, device as any) as any;
    zone.MIN_TEMP = 16;
    return { platform, device, zone };
}

describe('AtlanticPassAPCHeatingAndCoolingZone.getHeatingCooling (C3)', () => {
    it('uses the parent operating mode when available (cooling)', () => {
        const { zone } = makeZone({ parentStates: { 'io:PassAPCOperatingModeState': 'cooling' } });
        expect(zone.getHeatingCooling()).toBe('Cooling');
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

    it('reports AUTO and applies the confirmed target temperature when heating and idle', () => {
        const { zone } = makeZone({
            states: {
                'core:HeatingOnOffState': 'on',
                'core:HeatingTargetTemperatureState': 21,
            },
        });
        withCharacteristics(zone);
        zone.currentTemperature.value = 19; // below target -> actively heating
        zone.computeStates();
        expect(zone.targetState.value).toBe(3); // AUTO
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
