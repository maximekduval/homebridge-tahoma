<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# Homebridge TaHoma MK (Overkiz / Somfy)

[![npm](https://img.shields.io/npm/v/homebridge-tahoma-mk.svg)](https://www.npmjs.com/package/homebridge-tahoma-mk)

## About plugin
Homebridge plugin for Overkiz-based platforms (Somfy TaHoma / Connexoon, Cozytouch, Hi Kumo, Flexom, Rexel…), exposing your devices in Apple HomeKit.

This is a personal fork of [dubocr/homebridge-tahoma](https://github.com/dubocr/homebridge-tahoma) (Apache-2.0), published on npm as **`homebridge-tahoma-mk`**. It adds stability fixes on top of upstream, mainly:
- handles Somfy's `QUOTA_EXCEEDED` (429) rate limiting — the refresh period can be raised or disabled (`refreshPeriod: 0`);
- treats `NOT_TRANSMITTED` as a transient state (no more false warnings) and retries transient `DEVICE_DEFECT` failures with backoff;
- fixes commands lost when changing temperature and mode together;
- fixes the plugin name so accessories aren't re-created on every restart;
- robustness fixes around the Atlantic heat-pump heating/cooling zones.

Supported Overkiz services:

| Service code				| Vendor					| Product compatibility												|
|---------------------------|---------------------------|-------------------------------------------------------------------|
| `local`					| Somfy local API			| TaHoma, TaHoma Switch ([configure local API](#configure-local-api))												|
| `somfy_europe`			| Somfy Europe			 	| TaHoma, TaHoma Switch, Connexoon IO, Kit de connectivité Orange	|
| `somfy_australia`			| Somfy Australia	 		| Connexoon RTS and other products in Australia						|
| `somfy_north_america`		| Somfy North America 		| TaHoma and other product in North America							|
| `cozytouch`				| Atlantic, Thermor, Sauter | Cozytouch															|
| `flexom`					| Bouygues 					| Flexom															|
| `hi_kumo`					| Hitachi 					| Hi hi_kumo														|
| `rexel`					| Rexel					 	| Energeasy connectivité											|


# Installation

1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-tahoma-mk`
3. Update your configuration file. See bellow for a sample.

# Configuration

Minimal configuration sample:
```
{
	"bridge": {
		...
	},

	"description": "...",

	"accessories": [],

	"platforms":[
		{
			"platform": "Tahoma",
			"name": "My TaHoma Box",

			"service": "somfy_europe",
			"user": "user@me.com",
			"password": "MyPassw0rd",
		}
	]
}
```

Configuration parameters:

| Parameter					| Type			| Default			| Note											|
|---------------------------|---------------|-------------------|-----------------------------------------------|
| `service`					| String		| 'somfy_europe'	| optional, service name  (see above)			|
| `user`					| String		| null				| mandatory, your service account username (or [gateway PIN / IP address](#configure-local-api))	|
| `password`				| String		| null				| mandatory, your service account password (or [API token](#configure-local-api))	|
| `pollingPeriod`			| Integer		| 30				| optional, bridge polling period in seconds	|
| `refreshPeriod`			| Integer		| 30				| optional, device states refresh period in minutes	|
| `exclude`					| String[]		| []				| optional, protocol, ui, widget or device name to exclude	|
| `exposeScenarios`			| Boolean		| false				| optional, expose scenarios as HomeKit switches. Could also specify a list of string corresponding to scenarios names to expose	|
| `devicesConfig`			| Object[]		| []				| optional list of device specific configuration (see below)	|

### Configure Local API
Local API service is available on TaHoma and TaHoma switch gateways.

**WARNING: Switching to local API will break your HomeKit configuration (automations) as local API device identifiers actually differs.**

To use Local API you will have to:
1. Activate `developer mode` ([www.somfy.com](https://www.somfy.com) > My Account > Activate developer mode) 
2. Generate API credentials at [https://dev.duboc.pro/homebridge-tahoma](https://dev.duboc.pro/homebridge-tahoma)
3. Configure the plugin service to Local API: `"service":"local"`

When using Local API service, please fill `user` with your gateway PIN number or IPv4 address and `password` with the token generated at [step 2](https://dev.duboc.pro/homebridge-tahoma)

For more information, browse [https://developer.somfy.com/developer-mode](https://developer.somfy.com/developer-mode)

# Specific device configuration

This option allows you to apply a specific configuation to device or group of device.
One configuration is composed of a `key` attribute containing device name, widget, uiClass, protocol or unique identifier and as many parameter depending of device type.

```
{
	"key": "Bedroom door",
	"param1": "value1"
	...
}
```

| Alarm parameters	| Type		| Default		| Note					|
|-------------------|-----------|---------------|-----------------------|
| `stayZones`		| String	| 'A'			| optional, active zones (A,B,C) in 'Stay' mode	|
| `nightZones`		| String	| 'B'			| optional, active zones (A,B,C) in 'Night' mode	|
| `occupancySensor`	| Boolean	| false			| optional, add an occupancy widget linked to the alarm	|

| WindowCovering parameters	| Type		| Default		| Note			|
|---------------------------|-----------|---------------|---------------|
| `defaultPosition`			| Integer	| 0				| optional, final position for UpDown rollershutter after any command	|
| `reverse`					| Boolean	| false			| optional, reverse up/down in case of bad mounting	|
| `lowSpeed`				| Boolean / String	| false			| optional, use low speed for roller shutter supporting it. If string, specify slot time with format "HH:MM-HH:MM". Low speed will be enabled between them.	|
| `blindMode`				| String	| null			| optional, change main slider action to orientation. By default, both closure and orientation will be set. When setting ``blindMode: true`` the blinds work in the following way: Opening the blinds or setting them to 100% will fully open them. Closing the blinds or setting them to 0% will fully close them. Setting the blinds to a value between 1% and 99% will first close the blinds and then adjust thier horizontal tilt in a way that 99% means fully horizonal = more light, and 1% means nearly closed = less light. |
| `blindsOnRollerShutter`	| Boolean	| false				| optional, when blinds are installed on roller shutter motors allow slats to stay horizontal (opened) at intermediate position |
| `movementDuration`		| Integer	| 0				| optional, duration of a full shutter movement from 'open' to 'close' in seconds. Will be used to approximate shutter intermediate position. (0 = disable feature) |

| GarageDoorOpener parameters	| Type			| Default		| Note				|
|-------------------------------|---------------|---------------|-------------------|
| `cyclic`						| Boolean		| false			| optional, restore closed state after `cycleDuration` seconds for stateless devices with cyclic behaviour	|
| `cycleDuration`				| Integer		| false			| optional, cycle duration (in seconds) for cyclic mode (default: 5 sec)				|
| `reverse`						| Boolean		| false			| optional, reverse up/down in case of bad mounting	|
| `pedestrianDuration`			| Integer		| 0				| optional, duration for pedestrian position for RTS gates	|

| HeatingSystem parameters		| Type			| Default		| Note				|
|-------------------------------|---------------|---------------|-------------------|
| `derogationDuration`			| Integer		| 1				| optional, duration (in hours) for derogation orders	|
| `comfort`						| Integer		| 19			| optional, comfort temperature used as display for heaters controled by pilot wire	|
| `eco`							| Integer		| 17			| optional, comfort temperature used as display for heaters controled by pilot wire		|


Full configuration example:
```
{
	"bridge": {
		...
	},

	"description": "...",

	"accessories": [],

	"platforms":[
		{
			"platform": "Tahoma",
			"name": "My Tahoma Bridge",

			"user": "user@me.com",
			"password": "MyPassw0rd",
			"service": "somfy_europe",
			"exclude": ["hue", "rts", "Main door", "Main door", "PositionableHorizontalAwning"],

			"devicesConfig": [
				{
					"key": "Alarm",
					"stayZones": "A,C"
				},
				{
					"key": "Bedroom blind",
					"blindMode": true
				},
				{
					"key": "GarageDoor",
					"reverse": true
				},
				{
					"key": "UpDownRollerShutter",
					"defaultPosition": 50
				}
			]
		}
	]
}
```

# Contribute

You are welcome to contribute by opening an issue on this fork in case of unexpected behaviour or unsupported device: [github.com/maximekduval/homebridge-tahoma/issues](https://github.com/maximekduval/homebridge-tahoma/issues).

# Credits

Forked from [dubocr/homebridge-tahoma](https://github.com/dubocr/homebridge-tahoma) by Romain Duboc. All credit for the original plugin goes to the upstream author. Licensed under Apache-2.0.
