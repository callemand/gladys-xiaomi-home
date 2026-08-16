// Shared fixtures for the Xiaomi/Roborock integration tests.

// A miIO device token: 16 bytes = 32 hex characters.
export const TOKEN_HEX = '00112233445566778899aabbccddeeff';
export const DID = '123456789';

// A raw Mi Home device entry (as returned by /home/device_list -> result.list).
export const MI_DEVICE = {
  did: DID,
  name: 'Robot salon',
  model: 'roborock.vacuum.a15',
  token: TOKEN_HEX,
  localip: '127.0.0.1',
  mac: 'AA:BB:CC:DD:EE:FF',
  isOnline: true,
  ssid: 'home-wifi',
};

// A non-vacuum device that must be ignored by the discovery filter.
export const MI_OTHER_DEVICE = {
  did: '987654321',
  name: 'Lampe',
  model: 'yeelink.light.bslamp2',
  token: 'ffffffffffffffffffffffffffffffff',
  isOnline: true,
};

// A realistic get_status result (single element of the miIO result array).
export const STATUS = {
  msg_ver: 2,
  state: 8, // charging
  battery: 87,
  clean_time: 0,
  clean_area: 0,
  error_code: 0,
  fan_power: 102, // balanced
  in_cleaning: 0,
  in_returning: 0,
  dock_type: 21, // a robot with a station: the dock is published as its own device
};

// A realistic get_consumable result: the robot reports time USED, never left.
export const CONSUMABLE = {
  main_brush_work_time: 150 * 60 * 60, // half of its 300 h life
  side_brush_work_time: 50 * 60 * 60,
  filter_work_time: 15 * 60 * 60,
  sensor_dirty_time: 15 * 60 * 60,
  strainer_work_times: 15,
  cleaning_brush_work_times: 30,
  dust_collection_work_times: 9,
};

// A get_room_mapping result: segment id of the active map -> cloud room id.
export const ROOM_MAPPING = [
  [16, '1000001'],
  [17, '1000002'],
];

// The rooms of the account (/v2/homeroom/gethome), which put a name on them.
export const MI_HOME_ROOMS = [
  { id: '1000001', name: 'Cuisine' },
  { id: '1000002', name: 'Salon' },
];

// Xiaomi login secret (base64) used by the fake cloud in tests.
export const SSECURITY = Buffer.from('0123456789abcdef').toString('base64');
