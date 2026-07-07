// Maps user text to canonical room ids

const ROOM_IDS = ["drawing", "work1", "work2"];

const ALIASES = {
  drawing: "drawing",
  drawingroom: "drawing",
  waiting: "drawing",
  waitingroom: "drawing",
  work1: "work1",
  workroom1: "work1",
  work2: "work2",
  workroom2: "work2",
};

export function resolveRoom(input) {
  const key = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (ALIASES[key]) return ALIASES[key];
  if (ROOM_IDS.includes(key)) return key;
  // Rooms can be added at runtime
  const slug = String(input || "").trim().toLowerCase().replace(/\s+/g, "");
  return slug || null;
}

export { ROOM_IDS };
