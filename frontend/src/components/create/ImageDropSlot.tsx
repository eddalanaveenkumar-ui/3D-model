import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { ImageViewAngle } from '@nv3d/shared';
import { formatBytes } from '../../lib/format';

const ACCEPTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

interface ImageDropSlotProps {
  angle: ImageViewAngle;
  label: string;
  required?: boolean;
  compact?: boolean;
  file: File | null;
  maxUploadMb: number;
  onSelect: (file: File | null) => void;
  onValidationError: (message: string) => void;
}

export function ImageDropSlot({
  label,
  required,
  compact,
  file,
  maxUploadMb,
  onSelect,
  onValidationError,
}: ImageDropSlotProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleCandidate = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!ACCEPTED_MIMES.has(candidate.type)) {
      onValidationError(
        `"${candidate.name}" is not supported. Upload a PNG, JPG, or WEBP image.`
      );
      return;
    }
    if (candidate.size > maxUploadMb * 1024 * 1024) {
      onValidationError(
        `"${candidate.name}" exceeds the ${maxUploadMb} MB image upload limit.`
      );
      return;
    }
    onSelect(candidate);
  };

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-[#aeb7c9]">
          {label}
          {required && <span className="ml-1 text-[#8ed90b]">*</span>}
        </span>
        {file && (
          <span className="font-mono-tech text-[10px] text-[#78839a]">
            {formatBytes(file.size)}
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          handleCandidate(e.target.files?.[0]);
          e.currentTarget.value = '';
        }}
      />

      {file && previewUrl ? (
        <div
          className={`group relative overflow-hidden rounded-xl border border-[#2a3448] bg-[#0c0f16] ${
            compact ? 'h-24' : 'h-40'
          }`}
        >
          <img
            src={previewUrl}
            alt={`${label} reference preview`}
            className="h-full w-full object-contain"
          />
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2.5 py-1.5">
            <span className="truncate text-[10px] text-[#d8deea]">{file.name}</span>
            <button
              type="button"
              onClick={() => onSelect(null)}
              aria-label={`Remove ${label} image`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-black/60 text-rose-300 transition hover:bg-rose-500/25 hover:text-rose-200"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleCandidate(e.dataTransfer.files?.[0]);
          }}
          className={`flex w-full flex-col items-center justify-center rounded-xl border border-dashed transition ${
            compact ? 'h-24 px-2' : 'h-36 px-4'
          } ${
            dragging
              ? 'border-[#8ed90b] bg-[#76b900]/12 text-white'
              : 'border-[#293347] bg-[#0d1118] text-[#8d97ab] hover:border-[#3d4b66] hover:bg-[#121722] hover:text-[#d8deea]'
          }`}
        >
          <ImagePlus className={`${compact ? 'h-4 w-4' : 'h-5 w-5'} text-[#8ed90b]`} />
          <span className={`mt-1.5 font-medium ${compact ? 'text-[10px]' : 'text-xs'}`}>
            {compact ? 'Drop or select' : 'Drag & drop reference image'}
          </span>
          {!compact && (
            <span className="mt-0.5 text-[10px] text-[#6d788e]">
              PNG, JPG or WEBP up to {maxUploadMb} MB
            </span>
          )}
        </button>
      )}
    </div>
  );
}
