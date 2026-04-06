import { useMemo } from "react";

interface FloorGridProps {
  width: number;
  height: number;
}

export function FloorGrid({ width, height }: FloorGridProps) {
  const particles = useMemo(() => {
    const pts: Array<{ x: number; y: number; delay: number; duration: number; size: number }> = [];
    for (let i = 0; i < 20; i++) {
      pts.push({
        x: Math.random() * width,
        y: Math.random() * height,
        delay: Math.random() * 8,
        duration: 4 + Math.random() * 6,
        size: 1 + Math.random() * 2,
      });
    }
    return pts;
  }, [width, height]);

  const tileSize = 60;
  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  return (
    <g>
      {/* Base gradient */}
      <defs>
        <radialGradient id="floor-glow" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#4c6ef5" stopOpacity="0.03" />
          <stop offset="100%" stopColor="#0f1117" stopOpacity="0" />
        </radialGradient>
        <pattern id="grid-pattern" width={tileSize} height={tileSize} patternUnits="userSpaceOnUse">
          <rect width={tileSize} height={tileSize} fill="none" stroke="#2e3345" strokeWidth="0.5" strokeOpacity="0.3" />
        </pattern>
        {/* Isometric diamond pattern */}
        <pattern id="iso-tiles" width={tileSize * 2} height={tileSize} patternUnits="userSpaceOnUse">
          <path
            d={`M ${tileSize} 0 L ${tileSize * 2} ${tileSize / 2} L ${tileSize} ${tileSize} L 0 ${tileSize / 2} Z`}
            fill="none"
            stroke="#2e3345"
            strokeWidth="0.4"
            strokeOpacity="0.2"
          />
        </pattern>
      </defs>

      {/* Background fill */}
      <rect width={width} height={height} fill="#0f1117" />
      <rect width={width} height={height} fill="url(#floor-glow)" />

      {/* Grid lines */}
      <rect width={width} height={height} fill="url(#grid-pattern)" />
      <rect width={width} height={height} fill="url(#iso-tiles)" />

      {/* Subtle tile highlights - checkerboard effect */}
      {Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => {
          if ((r + c) % 4 !== 0) return null;
          return (
            <rect
              key={`${r}-${c}`}
              x={c * tileSize}
              y={r * tileSize}
              width={tileSize}
              height={tileSize}
              fill="#4c6ef5"
              fillOpacity="0.01"
              rx="2"
            />
          );
        })
      )}

      {/* Ambient floating particles */}
      {particles.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={p.size}
          fill="#4c6ef5"
          opacity="0"
          style={{
            animation: `ambient-drift ${p.duration}s ease-in-out ${p.delay}s infinite`,
          }}
        />
      ))}
    </g>
  );
}
