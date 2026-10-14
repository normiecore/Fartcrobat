import { FileKey2, KeyRound, Lock, LockOpen, PenOff, Shrink, SlidersHorizontal } from 'lucide-react'
import { defineFeature, openToolGroup, type CommandContext } from '@renderer/sdk'
import { hasFullAccess } from './certificates'
import { CompressPanel } from './CompressPanel'
import { enterPermissionsPassword, openCertificateEncryptDialog, openProtectDialog, removeSecurity } from './flows'
import { openOptimizerDialog } from './OptimizerDialog'
import { ProtectPanel } from './ProtectPanel'
import { SecurityBadge } from './SecurityBadge'
import { FEATURE_ID, isRestricted } from './shared'
import './styles.css'

const doc = (ctx: CommandContext) => ctx.doc!
const certificate = (ctx: CommandContext) => ctx.doc?.state.info.security === 'certificate'
const encrypted = (ctx: CommandContext) => !!ctx.doc?.state.info.encryption || certificate(ctx)
/** A certificate-encrypted document whose certificate may not change the security. */
const certificateLocked = (ctx: CommandContext) => certificate(ctx) && !hasFullAccess(ctx.doc!.state.info, ctx.doc!.state.unlock)

export default defineFeature({
  id: FEATURE_ID,
  commands: [
    {
      id: 'protect.encrypt',
      label: 'Protect Using Password…',
      icon: KeyRound,
      keywords: ['password', 'encrypt', 'security', 'lock', 'secure', 'permissions'],
      enabled: (ctx) => !certificateLocked(ctx),
      run: (ctx) => openProtectDialog(doc(ctx), 'password')
    },
    {
      id: 'protect.encryptCertificate',
      label: 'Encrypt with Certificate…',
      icon: FileKey2,
      keywords: ['certificate', 'certificate security', 'public key', 'digital id', 'recipients', 'encrypt', 'security', 'smart card'],
      enabled: (ctx) => !certificateLocked(ctx),
      run: (ctx) => openCertificateEncryptDialog(doc(ctx))
    },
    {
      id: 'protect.restrictEditing',
      label: 'Restrict Editing…',
      icon: PenOff,
      keywords: ['permissions', 'printing', 'copying', 'read only', 'security'],
      enabled: (ctx) => !certificateLocked(ctx),
      run: (ctx) => openProtectDialog(doc(ctx), 'restrict')
    },
    {
      id: 'protect.removeSecurity',
      label: 'Remove Security',
      icon: LockOpen,
      keywords: ['decrypt', 'unlock', 'password', 'unprotect', 'certificate'],
      enabled: (ctx) => encrypted(ctx) && !certificateLocked(ctx),
      run: (ctx) => removeSecurity(doc(ctx))
    },
    {
      id: 'protect.unlock',
      label: 'Enter Permissions Password…',
      icon: KeyRound,
      keywords: ['unlock', 'owner password', 'restrictions'],
      // Certificate security has no permissions password.
      enabled: (ctx) => encrypted(ctx) && !certificate(ctx) && isRestricted(ctx.doc!.state.info.permissions),
      run: (ctx) => enterPermissionsPassword(doc(ctx))
    },
    {
      id: 'protect.open',
      label: 'Protect a PDF',
      icon: Lock,
      keywords: ['security', 'password', 'encrypt'],
      run: () => openToolGroup('protect')
    },
    {
      id: 'compress.open',
      label: 'Compress a PDF…',
      icon: Shrink,
      keywords: ['reduce file size', 'optimize', 'smaller', 'shrink', 'optimizer'],
      run: () => openToolGroup('compress')
    },
    {
      id: 'compress.advanced',
      label: 'Advanced Optimization…',
      icon: SlidersHorizontal,
      keywords: ['pdf optimizer', 'optimized pdf', 'reduce file size', 'audit space usage', 'downsample'],
      run: (ctx) => openOptimizerDialog(doc(ctx))
    }
  ],
  menus: [
    { menu: 'file', group: 'protect', command: 'protect.encrypt', order: 600 },
    { menu: 'file', group: 'protect', command: 'protect.encryptCertificate', order: 601 },
    { menu: 'file', group: 'protect', command: 'protect.removeSecurity', order: 602 },
    { menu: 'file', group: 'protect', command: 'compress.open', order: 603 },
    { menu: 'file', group: 'protect', command: 'compress.advanced', order: 604 },
    { menu: 'tools', group: 'protect', command: 'protect.open', order: 600 },
    { menu: 'tools', group: 'protect', command: 'protect.encrypt', order: 601 },
    { menu: 'tools', group: 'protect', command: 'protect.encryptCertificate', order: 602 },
    { menu: 'tools', group: 'protect', command: 'protect.restrictEditing', order: 603 },
    { menu: 'tools', group: 'protect', command: 'protect.unlock', order: 604 },
    { menu: 'tools', group: 'protect', command: 'protect.removeSecurity', order: 605 },
    { menu: 'tools', group: 'compress', command: 'compress.open', order: 650 },
    { menu: 'tools', group: 'compress', command: 'compress.advanced', order: 651 }
  ],
  toolGroups: [
    {
      id: 'protect',
      label: 'Protect a PDF',
      icon: Lock,
      color: '#7b4fd6',
      description: 'Add a password, or restrict editing, printing and copying',
      order: 110,
      category: 'protect',
      panel: ProtectPanel,
      homeTile: true,
      keywords: ['password', 'encrypt', 'security', 'permissions', 'restrict', 'remove security', 'certificate']
    },
    {
      id: 'compress',
      label: 'Compress a PDF',
      icon: Shrink,
      color: '#e0592a',
      description: 'Reduce the file size, keeping the quality you choose',
      order: 130,
      category: 'protect',
      panel: CompressPanel,
      homeTile: true,
      keywords: ['reduce file size', 'optimize', 'pdf optimizer', 'smaller', 'downsample']
    }
  ],
  docToolbar: [{ id: 'protect-optimize-security', order: 80, component: SecurityBadge }]
})
