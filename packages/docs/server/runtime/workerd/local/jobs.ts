import { Inert } from '../inert.ts';
// The assistant's app-change jobs are retired in the suite.
export class JobRunner extends Inert {}
export class JobStore extends Inert {}
export const publicJob = (j: any): any => j;
export const workerLauncher = (..._a: any[]): any => null;
export type Launcher = any;
