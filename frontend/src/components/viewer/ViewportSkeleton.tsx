import { Box } from 'lucide-react';

export function ViewportSkeleton() {
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-[#0f131a] select-none">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#252d3e] bg-[#151a24]">
          <Box className="h-6 w-6 animate-pulse text-[#8ed90b]" />
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-[#d4dae6]">
            Initializing Three.js PBR Viewport
          </p>
          <p className="mt-0.5 text-[11px] text-[#78839a]">
            Loading WebGL studio environment and GLTFLoader
          </p>
        </div>
      </div>
    </div>
  );
}
