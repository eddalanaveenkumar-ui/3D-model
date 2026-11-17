// ============================================================================
// Safety & Sanitization Service — Weapons-free policy + XSS/HTML prevention
// ============================================================================

const WEAPON_PATTERNS: readonly { pattern: RegExp; term: string }[] = [
  { pattern: /\b(firearm|firearms|handgun|handguns|pistol|pistols|revolver|revolvers)\b/i, term: 'firearm' },
  { pattern: /\b(rifle|rifles|shotgun|shotguns|carbine|sniper|submachine|assault\s+weapon|ak-?47|ar-?15|glock|uzi)\b/i, term: 'firearm' },
  { pattern: /\b(machine\s*gun|minigun|gatling|railgun|turret\s+gun|blaster\s+rifle)\b/i, term: 'weapon' },
  { pattern: /\b(ammunition|ammo|bullet|bullets|gunpowder|shell\s+casing)\b/i, term: 'ammunition' },
  { pattern: /\b(grenade|grenades|landmine|landmines|claymore|c-?4\s+explosive|dynamite|pipe\s+bomb|molotov|warhead|missile|missiles|torpedo|bazooka|rocket\s+launcher)\b/i, term: 'explosive/ordnance' },
  { pattern: /\b(sword|swords|katana|dagger|daggers|bayonet|machete|switchblade|combat\s+knife|hunting\s+knife|battle\s*axe|halberd|spear|crossbow|brass\s+knuckles)\b/i, term: 'bladed/melee weapon' },
  { pattern: /\b(lethal\s+weapon|military\s+weapon|weaponry)\b/i, term: 'weaponry' },
];

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Strip ASCII control characters (except standard whitespace) and neutralize
 * embedded HTML/script tags so untrusted strings can never execute script
 * even if serialized outside React.
 */
export function sanitizePlainText(input: string, maxLength = 4000): string {
  const withoutControls = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const withoutScripts = withoutControls
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|svg|math|style|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/on[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/[<>]/g, '');
  return withoutScripts.trim().slice(0, maxLength);
}

/**
 * Enforce NV3D Studio's weapons-free 3D asset policy.
 * Supports humans, animals, cars, buildings, furniture, weapons-free props, trees, and environments.
 */
export function checkWeaponsFreePolicy(prompt: string): PolicyCheckResult {
  const normalized = prompt.toLowerCase();
  // Allow explicit negation such as "weapons-free", "no weapons", "unarmed"
  const scrubbed = normalized
    .replace(/\bweapons?[-\s]free\b/g, '')
    .replace(/\bno\s+weapons?\b/g, '')
    .replace(/\bwithout\s+weapons?\b/g, '')
    .replace(/\bblade\s+of\s+grass\b/g, '')
    .replace(/\bfan\s+blades?\b/g, '')
    .replace(/\bturbine\s+blades?\b/g, '')
    .replace(/\bpropeller\s+blades?\b/g, '')
    .replace(/\bbutter\s+knife\b/g, '');

  for (const rule of WEAPON_PATTERNS) {
    if (rule.pattern.test(scrubbed)) {
      return {
        allowed: false,
        reason: `Prompt blocked by NV3D Studio's weapons-free policy (detected restricted category: ${rule.term}). Supported categories include humans, animals, vehicles, buildings, furniture, weapons-free props, trees, and environments.`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Produce a safe RFC-6266 ASCII download filename with the desired extension.
 */
export function toSafeDownloadFilename(name: string, ext: 'glb' | 'gltf'): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${slug || 'nv3d-model'}.${ext}`;
}
