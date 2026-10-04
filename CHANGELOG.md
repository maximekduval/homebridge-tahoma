# Changelog

Changes of `homebridge-tahoma-mk`, the fork of
[dubocr/homebridge-tahoma](https://github.com/dubocr/homebridge-tahoma). The
history of the versions before the fork is in the upstream repository.

## 1.0.19

Changes taken from upstream
[dubocr/homebridge-tahoma](https://github.com/dubocr/homebridge-tahoma) 2.2.62
to 2.2.64:

- Air quality sensors show their air quality from `core:AirQualityState`, and
  report whether they are active, in fault or low on battery. The
  `enocean:EnOceanHumidityComfortSensor` is no longer exposed.
- Water heaters accept a minimum target temperature of 40 °C instead of 45 °C.
- Remove the duplicate "Flexom (Bouygues)" entry from the service list of the
  settings.
- Update `overkiz-client` to 1.0.23: the local API finds the gateway on the
  network again, and its dependencies `axios` and `uuid` get their security
  fixes. Update `moment` to 2.31.0 for its security fix.
- Describe the current way to activate the developer mode for the local API,
  from the TaHoma By Somfy app.
- Declare Homebridge 2 support.

## 1.0.18

First version on npm since 1.0.15. It brings the fix of 1.0.16:

- Log in again and retry once when TaHoma answers `429 QUOTA_EXCEEDED`, as
  already done for a `401`. Somfy's quota seems tied to the login session, so a
  new session clears the block instead of failing every call until the next
  scheduled attempt.

## 1.0.17

- No code change since 1.0.16. Not published on npm.

## 1.0.16

- Log in again and retry once when TaHoma answers `429 QUOTA_EXCEEDED`, as
  already done for a `401`. Somfy's quota seems tied to the login session, so a
  new session clears the block instead of failing every call until the next
  scheduled attempt. Not published on npm.

## 1.0.15

First version on npm since 1.0.13. It brings the changes of 1.0.14:

- Refresh the state of every device once at startup, so a change made outside
  HomeKit (for example a setpoint set on a heat pump's physical remote) shows
  up after a restart. Skipped when `refreshPeriod` is `0`.
- Warn at startup when `refreshPeriod` is `0`, because changes made outside
  HomeKit may then never reach it.

## 1.0.14

- Refresh the state of every device once at startup, so a change made outside
  HomeKit (for example a setpoint set on a heat pump's physical remote) shows
  up after a restart. Skipped when `refreshPeriod` is `0`.
- Warn at startup when `refreshPeriod` is `0`, because changes made outside
  HomeKit may then never reach it.
- Rebrand the README for the fork.

## 1.0.13

- Revert the change of 1.0.12.

## 1.0.12

- Show the real season right away when a heat pump zone is turned on from off,
  instead of briefly showing heating.

## 1.0.11

- Fix `refreshPeriod: 0`: the periodic full-state refresh was firing constantly
  and exhausting Somfy's quota instead of being disabled.

## 1.0.10

- Keep the full list of modes on a heat pump zone that is off, so turning it on
  from the Home grid view no longer shows "No Response". The modes are narrowed
  to off plus the current season only while the zone is on.

## 1.0.9

- Offer only off plus the current season (heat or cool) on a heat pump zone
  when the season is known for sure.

## 1.0.8

- No code change.

## 1.0.7

- Allow `refreshPeriod: 0` to disable the periodic full-state refresh, which
  can trigger `429 QUOTA_EXCEEDED` errors. Devices still update through polling.
- Fix the plugin name so cached accessories are restored instead of being
  created again on every restart.

## 1.0.6

- Treat `NOT_TRANSMITTED` as a normal intermediate step of a command instead of
  a failure, and retry transient `DEVICE_DEFECT` failures.

## 1.0.5

- Accept both heat and cool on a heat pump zone, so turning on the air
  conditioning no longer shows "No Response".

## 1.0.4

- Show "Heat" or "Cool" instead of "Auto" on heat pump zones.

## 1.0.3

- Answer HomeKit right away when a heating mode is changed, instead of waiting
  for TaHoma, so a slow request no longer makes the accessory show
  "No Response".

## 1.0.2

- Retry heating commands up to 5 times on transient gateway errors.

## 1.0.1

- First version of the `homebridge-tahoma-mk` fork, with stability fixes over
  upstream: commands no longer lost when temperature and mode change together,
  more reliable state refresh and setpoints, and fixes for the Atlantic heat
  pump zones.
