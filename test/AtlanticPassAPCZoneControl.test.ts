import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/Platform', () => ({
    Characteristics: {
        TargetHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
        CurrentHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2 },
        Name: 'Name',
        On: 'On',
    },
    Services: { Switch: 'Switch', Thermostat: 'Thermostat' },
}));

import ZoneControl from '../src/mappers/HeatingSystem/AtlanticPassAPCZoneControl';
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

/** Accessory stub that hands out fake services backed by FakeCharacteristic. */
function makeAccessory() {
    const services: any[] = [];
    return {
        services,
        getService: () => undefined,
        getServiceById: () => undefined,
        removeService: vi.fn(),
        addService: (type: string, name: string, subtype?: string) => {
            const characteristics = new Map<string, FakeCharacteristic>();
            const service = {
                UUID: type,
                subtype,
                setCharacteristic: () => service,
                setPrimaryService: () => service,
                addOptionalCharacteristic: () => service,
                getCharacteristic: (c: string) => {
                    if (!characteristics.has(c)) {
                        characteristics.set(c, new FakeCharacteristic(String(c)));
                    }
                    return characteristics.get(c);
                },
            };
            services.push(service);
            return service;
        },
    };
}

function makeZoneControl(states: Record<string, unknown>) {
    const platform = new FakePlatform();
    const device = new FakeDevice({ widgetName: 'AtlanticPassAPCZoneControl', states });
    const mapper = new ZoneControl(platform as any, makeAccessory() as any, device as any) as any;
    // Characteristics are wired by hand, as in HeatingSystem.test.ts: under the
    // test transpiler, class fields are re-initialised after the base constructor
    // has registered the services.
    mapper.currentState = new FakeCharacteristic('CurrentHeatingCoolingState');
    mapper.targetState = new FakeCharacteristic('TargetHeatingCoolingState');
    mapper.dehumidifier = new FakeCharacteristic('On', false);
    return { platform, device, mapper };
}

describe('AtlanticPassAPCZoneControl.computeStates', () => {
    it('does not report Heat while the main controller is dehumidifying', () => {
        const { mapper } = makeZoneControl({ 'io:PassAPCOperatingModeState': 'drying' });
        mapper.computeStates();
        expect(mapper.targetState.value).toBe(0); // OFF
        expect(mapper.currentState.value).toBe(0); // OFF
        expect(mapper.dehumidifier.value).toBe(true);
    });

    it('turns the dehumidifier switch off when back to heating', () => {
        const { mapper, device } = makeZoneControl({ 'io:PassAPCOperatingModeState': 'drying' });
        mapper.computeStates();
        device.set('io:PassAPCOperatingModeState', 'heating');
        mapper.computeStates();
        expect(mapper.targetState.value).toBe(1); // HEAT
        expect(mapper.currentState.value).toBe(1); // HEAT
        expect(mapper.dehumidifier.value).toBe(false);
    });

    it('reports AUTO when the heating/cooling auto switch is on', () => {
        const { mapper } = makeZoneControl({
            'io:PassAPCOperatingModeState': 'cooling',
            'core:HeatingCoolingAutoSwitchState': 'on',
        });
        mapper.computeStates();
        expect(mapper.targetState.value).toBe(3); // AUTO
        expect(mapper.currentState.value).toBe(2); // COOL
    });

    it('reports AUTO when the operating mode itself is auto', () => {
        const { mapper } = makeZoneControl({ 'io:PassAPCOperatingModeState': 'auto' });
        mapper.computeStates();
        expect(mapper.targetState.value).toBe(3); // AUTO
        expect(mapper.dehumidifier.value).toBe(false);
    });
});

describe('AtlanticPassAPCZoneControl dehumidifier switch', () => {
    it('sends the drying operating mode when switched on', () => {
        const { mapper } = makeZoneControl({});
        const commands = mapper.getDehumidifierCommands(true);
        expect(commands.map((c: any) => [c.name, c.parameters])).toEqual([
            ['setPassAPCOperatingMode', ['drying']],
            ['setHeatingCoolingAutoSwitch', ['off']],
        ]);
    });

    it('stops the system when switched off', () => {
        const { mapper } = makeZoneControl({});
        const commands = mapper.getDehumidifierCommands(false);
        expect(commands.map((c: any) => [c.name, c.parameters])).toEqual([
            ['setPassAPCOperatingMode', ['stop']],
        ]);
    });
});
