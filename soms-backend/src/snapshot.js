import { state } from "./state.js";

// Shared builder for REST and WS snapshots
export function buildSnapshot() {
  return {
    devices: state.devices.map((d) => ({ ...d })),
    pcs: state.pcs.map((p) => ({ ...p })),
    environment: JSON.parse(JSON.stringify(state.environment)),
    occupancy: { ...state.occupancy },
    automation: JSON.parse(JSON.stringify(state.automation)),
    smokeLevel: { ...state.smokeLevel },
    fireAlert: { ...state.fireAlert },
    settings: JSON.parse(JSON.stringify(state.settings)),
    hardware: JSON.parse(JSON.stringify(state.hardware)),
    weather: state.weather ? { ...state.weather } : null,
  };
}
