// The desktop app's features have no part in a hosted object. Their stand-ins answer every method with nothing, so the
// shared code that sets them up and calls into them runs as it does when the feature is off.
export class Inert {
  [key: string]: any;
  constructor(..._args: unknown[]) {
    return new Proxy(this, { get: (target, key) => (key in target ? (target as any)[key] : key === 'then' ? undefined : () => undefined) });
  }
}
