// The request's context on Node: one process serves one data directory, so a request is for no organization in particular.
export const currentOrganization = (): string | undefined => undefined;
