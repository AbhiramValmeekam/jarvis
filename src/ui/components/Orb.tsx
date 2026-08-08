import { orbLook, orbScale, type HudFacts } from "../hud-model";

/**
 * The orb.
 *
 * Everything it shows is derived from real runtime state through `orbLook`, so
 * it cannot animate its way into implying something that isn't happening.
 */
export function Orb({ facts, level }: { facts: HudFacts; level: number }) {
  const look = orbLook(facts);
  const scale = orbScale(level, look.mode);

  const animClass =
    look.animation === "breathe"
      ? "animate-breathe"
      : look.animation === "spin"
        ? "animate-spin-slow"
        : "";

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative grid h-44 w-44 place-items-center">
        {/* Outward ripples: one per unit of energy the state carries. */}
        {Array.from({ length: look.rings }).map((_, i) => (
          <span
            key={i}
            className="animate-ripple absolute h-32 w-32 rounded-full border"
            style={{ borderColor: look.color, animationDelay: `${i * 0.6}s` }}
          />
        ))}

        {/* Outer halo */}
        <span
          className="absolute h-40 w-40 rounded-full blur-2xl transition-colors duration-700"
          style={{ background: look.color, opacity: look.mode === "offline" ? 0.1 : 0.22 }}
        />

        {/* Rotating arc: reads as computation without pretending to be a %. */}
        {look.animation === "spin" && (
          <span
            className="animate-spin-slow absolute h-36 w-36 rounded-full border-2 border-transparent"
            style={{ borderTopColor: look.color, borderRightColor: look.color }}
          />
        )}

        {/* Core */}
        <span
          className="relative h-24 w-24 rounded-full transition-all duration-500"
          style={{
            transform: `scale(${scale})`,
            background: `radial-gradient(circle at 32% 28%, #ffffff40, ${look.color} 45%, ${look.color}22 100%)`,
            boxShadow: `0 0 40px ${look.color}66, inset 0 0 24px ${look.color}55`,
          }}
        />

        <span
          className={`absolute h-24 w-24 rounded-full ${animClass}`}
          style={{ boxShadow: `0 0 0 1px ${look.color}55` }}
        />
      </div>

      <p
        className="text-sm font-medium tracking-wide transition-colors duration-500"
        style={{ color: look.color }}
      >
        {look.label}
      </p>
    </div>
  );
}
