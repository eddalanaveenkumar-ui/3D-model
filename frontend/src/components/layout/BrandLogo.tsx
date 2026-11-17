export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#76b900]/40 bg-[#76b900]/12">
        <svg
          viewBox="0 0 28 28"
          fill="none"
          aria-hidden="true"
          className="h-5 w-5"
        >
          <path
            d="M14 2.8L24 8.5V19.5L14 25.2L4 19.5V8.5L14 2.8Z"
            stroke="#8ED90B"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <path
            d="M14 2.8V14M14 14L24 8.5M14 14L4 8.5M14 14V25.2"
            stroke="#76B900"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="14" cy="14" r="2.1" fill="#A3E635" />
        </svg>
      </div>
      {!compact && (
        <div className="flex items-baseline gap-1.5 leading-none">
          <span className="text-[15px] font-bold tracking-tight text-white">NV3D</span>
          <span className="text-[13px] font-medium tracking-tight text-[#8d97ab]">Studio</span>
        </div>
      )}
    </div>
  );
}
