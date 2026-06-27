
/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'Tahoma';

/**
 * Plugin identifier — MUST match the "name" field in package.json. Homebridge
 * keys a dynamic platform's accessories by this identifier; a mismatch makes
 * registerPlatformAccessories reference a plugin/platform Homebridge can't link
 * ("The platform couldn't be found though!") and prevents cached accessories
 * from being restored, so every restart re-creates them.
 */
export const PLUGIN_NAME = 'homebridge-tahoma-mk';