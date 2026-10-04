import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/Platform', () => ({
    Characteristics: {
        AirQuality: { UNKNOWN: 0, EXCELLENT: 1, GOOD: 2, FAIR: 3, INFERIOR: 4, POOR: 5 },
        StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
        StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
        StatusActive: 'StatusActive',
    },
    Services: { AirQualitySensor: 'AirQualitySensor' },
}));

import AirSensor from '../src/mappers/AirSensor';
import { Characteristics } from '../src/Platform';
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

function makeSensor(states: Record<string, unknown> = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice({ uiClass: 'AirSensor', widgetName: 'AirSensor', states });
    const sensor = new AirSensor(platform as any, {} as any, device as any) as any;
    const characteristics = new Map<unknown, FakeCharacteristic>();
    sensor.registerService = () => ({
        getCharacteristic: (type: unknown) => {
            if (!characteristics.has(type)) {
                characteristics.set(type, new FakeCharacteristic(String(type)));
            }
            return characteristics.get(type);
        },
    });
    sensor.registerMainService();
    return { sensor, characteristics };
}

describe('AirSensor', () => {
    it('maps core:AirQualityState to the HomeKit air quality', () => {
        const { sensor } = makeSensor();
        const cases: Array<[string, number]> = [
            ['optimalAirRange', Characteristics.AirQuality.EXCELLENT],
            ['slightlyHumidRange', Characteristics.AirQuality.GOOD],
            ['dryAirRange', Characteristics.AirQuality.FAIR],
            ['highHumidityRange', Characteristics.AirQuality.INFERIOR],
            ['mouldsRisk', Characteristics.AirQuality.POOR],
            ['error', Characteristics.AirQuality.UNKNOWN],
        ];
        for (const [state, expected] of cases) {
            sensor.onStateChanged('core:AirQualityState', state);
            expect(sensor.quality.value).toBe(expected);
        }
    });

    it('ignores the other states instead of writing them as air quality', () => {
        const { sensor } = makeSensor();
        sensor.onStateChanged('core:RelativeHumidityState', 55);
        expect(sensor.quality.updates).toEqual([]);
    });

    it('reports a low battery and a fault from core:SensorDefectState', () => {
        const { sensor } = makeSensor({ 'core:SensorDefectState': 'noDefect' });
        sensor.onStateChanged('core:SensorDefectState', 'lowBattery');
        expect(sensor.battery.value).toBe(Characteristics.StatusLowBattery.BATTERY_LEVEL_LOW);
        sensor.onStateChanged('core:SensorDefectState', 'dead');
        expect(sensor.fault.value).toBe(Characteristics.StatusFault.GENERAL_FAULT);
        sensor.onStateChanged('core:SensorDefectState', 'noDefect');
        expect(sensor.fault.value).toBe(Characteristics.StatusFault.NO_FAULT);
        expect(sensor.battery.value).toBe(Characteristics.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    });

    it('exposes StatusActive only when the device has core:StatusState', () => {
        expect(makeSensor().sensor.active).toBeUndefined();
        const { sensor } = makeSensor({ 'core:StatusState': 'available' });
        sensor.onStateChanged('core:StatusState', 'unavailable');
        expect(sensor.active.value).toBe(false);
        sensor.onStateChanged('core:StatusState', 'available');
        expect(sensor.active.value).toBe(true);
    });
});
