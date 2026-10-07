export const host = { registration: null, session: null };

export class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createCanvas(options) {
  return options;
}

export async function joinSession(registration) {
  if (!host.session) throw new Error("Configure the isolated test host before loading the extension.");
  host.registration = registration;
  return host.session;
}
