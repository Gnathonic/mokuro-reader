/**
 * Who may read and write `positions.json`.
 *
 * On plain storage the file is the user's own, like `volume-data.json`. On
 * mokuro-bunko every path under the mokuro folder is the SHARED library unless
 * the server maps it per account, so the client touches it only once bunko
 * says it keeps it per user (`positionsSync`, from `per_user_files`: a bunko
 * server's identity, or a cloud-direct folder's lease-holder marker).
 */

import type { ProviderStatus } from '$lib/util/sync/provider-interface';

type PositionsGates = Pick<
  ProviderStatus,
  'positionsSync' | 'serverCompilesMetadata' | 'isReadOnly'
>;

export function positionsReadAllowed(status: PositionsGates): boolean {
  return status.positionsSync ?? !status.serverCompilesMetadata;
}

export function positionsWriteAllowed(status: PositionsGates): boolean {
  return positionsReadAllowed(status) && !status.isReadOnly;
}
