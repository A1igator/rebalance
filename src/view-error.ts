const messages = {
  'local-access-denied': 'This process cannot access the local chart listener.',
  'listener-incompatible': 'The local listener does not provide a compatible portfolio view.',
  'ownership-unverified': 'The chart listener is not owned by this portfolio or its ownership could not be verified.',
  'startup-unverified': 'Chart startup is not yet verified; no duplicate was started.',
  unavailable: 'The portfolio selector is unavailable.',
} as const;

export type ViewFailureCode = keyof typeof messages;
export class ViewError extends Error {
  constructor(readonly code: ViewFailureCode) { super(messages[code]); this.name = 'ViewError'; }
}

/** Only allowlisted codes and fixed text cross the public view boundary. */
export function publicViewFailure(error: unknown) {
  const code = error instanceof ViewError && Object.hasOwn(messages, error.code) ? error.code : 'unavailable';
  return { state: 'unavailable' as const, code, message: messages[code] };
}
