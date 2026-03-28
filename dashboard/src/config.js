export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';

export const SF_CENTER = [-122.4194, 37.7749];
export const SF_BOUNDS = [[-122.55, 37.70], [-122.33, 37.84]];

export const AIRCRAFT_API = '/api/aircraft/v2/point/37.7749/-122.4194/125';

export const ANTENNA_LOCATION = [-122.4034, 37.7901];
export const FIRE_DISPATCH_API = 'https://data.sfgov.org/resource/nuek-vuh3.json';
export const POLICE_DISPATCH_API = 'https://data.sfgov.org/resource/gnap-fj3t.json';

export const POLL_INTERVALS = {
  aircraft: 5000,
  dispatch: 30000,
  marine: 10000,
  radio: 3000,
  transit: 15000,
  workZones: 300000,
};

export const SFPD_CALLSIGNS = ['N911SF', 'N81SF', 'SFPD', 'CHP'];
export const COAST_GUARD_KEYWORDS = ['GUARD', 'USCG', 'CGD'];
