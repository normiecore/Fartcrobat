// Types for names.mjs (plain JavaScript so that the workflow and linux.sh can run it with node).
export declare const FIRST_INKMOOR: string
export declare const FIRST_INKMOOR_REPO: string
export declare const DEB_PACKAGE: string
export declare function releaseRepo(version: string): string
export declare const ALL_NAMES: string[]
export declare function versionBefore(a: string, b: string): boolean
export declare function productName(version: string): 'Fartcrobat' | 'Inkmoor'
export interface ProductNames {
  version: string
  name: 'Fartcrobat' | 'Inkmoor'
  windowGlobal: string
  envPrefix: string
  userData: string
  updaterCache: string
  winExe: string
  winSetupX64: string
  winSetupArm64: string
  winSetupCombined: string
  winPolicyKey: string
  macDmgArm64: string
  macApp: string
  macExe: string
  macPolicy: string
  debFile: string
  debDir: string
  debExe: string
  debAppArmor: string
  linuxPolicy: string
  appImage: string
  repo: string
}
export declare function productFor(version: string): ProductNames
export declare function checkoutName(): string
export declare function defaultNew(old: string, name?: string): string
