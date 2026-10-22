import { posix } from "node:path";

export const joinPosixPath = (...segments: string[]): string =>
  posix.join(...segments);
