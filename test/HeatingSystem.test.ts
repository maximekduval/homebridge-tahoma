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

    it('never narrows validValues at runtime (avoids HAP rejecting the turn-on write)', () => {
        // Regression: computeStates() used to call setProps({ validValues: [activeMode, OFF] }).
        // While the zone was off, getHeatingCooling() fell back to Heating, shrinking
        // validValues to [HEAT, OFF]. HomeKit still cached COOL, so the next "turn on"
        // tap wrote COOL — rejected by HAP before onSet (No Response, no log).
        const { zone } = makeZone({ states: { 'core:HeatingOnOffState': 'off' } });
        withCharacteristics(zone);
        // Simulate registerMainService having published the stable, complete set.
        zone.targetState.setProps({ validValues: [0, 1, 2] }); // OFF, HEAT, COOL
        zone.computeStates();
        expect(zone.targetState.props.validValues).toEqual([0, 1, 2]);
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
        expect(mapper.MIN_TEMP).toBe(45);
        expect(mapper.MAX_TEMP).toBe(65);
    });
});
