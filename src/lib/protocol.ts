// OpticalDrop & Direct QR Protocol implementation for Android Scanner

export interface FramePayload {
  protocolVersion: number;
  transferId: string;
  frameIndex: number;
  totalFrames: number;
  payload: string;
  checksum?: string;
  frameType: 'metadata' | 'data' | 'parity' | 'complete';
}

export interface TransferMetadata {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  checksum: string;
  protocolVersion: number;
  isSingleQr?: boolean;
  rawText?: string;
  dimensions?: { width: number; height: number };
}

export interface SingleQrImageResult {
  isImage: boolean;
  blob?: Blob;
  imageUrl?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  rawText?: string;
}

export function decodeFrame(data: string): FramePayload | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;

    // Flexible field alias handling for frameIndex
    const rawFrameIndex = parsed.frameIndex ?? parsed.index ?? parsed.i ?? parsed.idx;
    if (typeof rawFrameIndex !== 'number') return null;

    // Flexible field alias handling for payload
    const rawPayload = parsed.payload ?? parsed.data ?? parsed.p ?? parsed.d;
    if (typeof rawPayload !== 'string') return null;

    // Flexible field alias handling for frameType
    let rawFrameType = (parsed.frameType ?? parsed.type ?? parsed.t ?? 'data').toString().toLowerCase();
    if (rawFrameType === 'm' || rawFrameType === 'meta' || rawFrameType === 'header') {
      rawFrameType = 'metadata';
    } else if (rawFrameType === 'd' || rawFrameType === 'chunk') {
      rawFrameType = 'data';
    } else if (rawFrameType === 'p' || rawFrameType === 'fec') {
      rawFrameType = 'parity';
    } else if (rawFrameType === 'c' || rawFrameType === 'done' || rawFrameType === 'end') {
      rawFrameType = 'complete';
    }

    const totalFrames = parsed.totalFrames ?? parsed.totalChunks ?? parsed.total ?? parsed.n ?? 1;
    const transferId = parsed.transferId ?? parsed.id ?? 'default_transfer';
    const protocolVersion = parsed.protocolVersion ?? parsed.v ?? 1;
    const checksum = parsed.checksum ?? parsed.hash ?? parsed.c ?? undefined;

    return {
      protocolVersion,
      transferId,
      frameIndex: rawFrameIndex,
      totalFrames,
      payload: rawPayload,
      checksum,
      frameType: rawFrameType as FramePayload['frameType'],
    };
  } catch {
    return null;
  }
}

export function parseSingleQrContent(data: string): SingleQrImageResult {
  const trimmed = data.trim();

  // 1. Check for Data URI (e.g. data:image/png;base64,....)
  if (trimmed.startsWith('data:image/')) {
    try {
      const mimeType = trimmed.substring(5, trimmed.indexOf(';')) || 'image/png';
      const ext = mimeType.split('/')[1] || 'png';
      const base64Data = trimmed.substring(trimmed.indexOf(',') + 1);
      const bytes = base64ToArrayBuffer(base64Data);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
      const fileName = `scanned_image_${Date.now()}.${ext}`;
      return {
        isImage: true,
        blob,
        imageUrl: URL.createObjectURL(blob),
        fileName,
        fileSize: blob.size,
        mimeType,
        rawText: trimmed.substring(0, 100) + '...',
      };
    } catch (e) {
      console.error('Failed to parse data:image URI', e);
    }
  }

  // 2. Check for JSON format containing image/data
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      const imagePayload = parsed.image || parsed.img || parsed.data || parsed.url || parsed.file;
      const fileName = parsed.name || parsed.fileName || `scanned_image_${Date.now()}.png`;
      const mimeType = parsed.mimeType || parsed.type || inferMimeTypeFromFileName(fileName);

      if (typeof imagePayload === 'string') {
        if (imagePayload.startsWith('data:image/')) {
          return parseSingleQrContent(imagePayload);
        } else if (/^https?:\/\//i.test(imagePayload)) {
          return {
            isImage: true,
            imageUrl: imagePayload,
            fileName,
            fileSize: 0,
            mimeType,
            rawText: trimmed,
          };
        } else if (imagePayload.length > 50 && !imagePayload.includes(' ')) {
          // Attempt raw base64 decode
          try {
            const bytes = base64ToArrayBuffer(imagePayload);
            const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
            return {
              isImage: true,
              blob,
              imageUrl: URL.createObjectURL(blob),
              fileName,
              fileSize: blob.size,
              mimeType,
              rawText: trimmed,
            };
          } catch {
            // not base64
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Check for Direct Image URL (http/https ending in image extensions or containing image keywords)
  if (/^https?:\/\//i.test(trimmed)) {
    const isImageExt = /\.(jpg|jpeg|png|webp|gif|svg|bmp|ico|avif)(\?.*)?$/i.test(trimmed);
    const hasImageKeywords = /(images|photos|media|img|uploads|avatar|assets|cdn|picsum|unsplash)/i.test(trimmed);

    if (isImageExt || hasImageKeywords) {
      const extMatch = trimmed.match(/\.(jpg|jpeg|png|webp|gif|svg|bmp|ico|avif)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const mimeType = inferMimeTypeFromFileName(`file.${ext}`);
      return {
        isImage: true,
        imageUrl: trimmed,
        fileName: `image_${Date.now()}.${ext}`,
        fileSize: 0,
        mimeType,
        rawText: trimmed,
      };
    }
  }

  // 4. Check for raw Base64 string that starts with image signatures
  // PNG starts with iVBORw0KGgo, JPEG starts with /9j/, WebP starts with UklGR
  if (trimmed.length > 100 && (trimmed.startsWith('iVBORw0KGgo') || trimmed.startsWith('/9j/') || trimmed.startsWith('UklGR'))) {
    try {
      let mimeType = 'image/png';
      let ext = 'png';
      if (trimmed.startsWith('/9j/')) {
        mimeType = 'image/jpeg';
        ext = 'jpg';
      } else if (trimmed.startsWith('UklGR')) {
        mimeType = 'image/webp';
        ext = 'webp';
      }
      const bytes = base64ToArrayBuffer(trimmed);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
      return {
        isImage: true,
        blob,
        imageUrl: URL.createObjectURL(blob),
        fileName: `scanned_image_${Date.now()}.${ext}`,
        fileSize: blob.size,
        mimeType,
        rawText: trimmed.substring(0, 100) + '...',
      };
    } catch {
      // not base64
    }
  }

  // 5. Default: generic text / link payload
  return {
    isImage: false,
    fileName: `scanned_content_${Date.now()}.txt`,
    fileSize: new Blob([trimmed]).size,
    mimeType: 'text/plain',
    rawText: trimmed,
  };
}

export function playSuccessSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    
    // Play dual futuristic chime tone
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5

    osc2.frequency.setValueAtTime(880, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.15); // D6

    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.35);
    osc2.stop(ctx.currentTime + 0.35);
  } catch (e) {
    console.warn('Audio feedback error', e);
  }
}

export function triggerHaptic() {
  try {
    if (navigator.vibrate) {
      navigator.vibrate([40, 30, 80]);
    }
  } catch {
    // ignore
  }
}

export function parseMetadata(payloadStr: string): Partial<TransferMetadata> {
  try {
    const parsed = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    if (!parsed || typeof parsed !== 'object') return {};

    const fileName = parsed.fileName ?? parsed.name ?? parsed.filename ?? parsed.fn ?? 'scanned_file';
    const fileSize = parsed.fileSize ?? parsed.size ?? parsed.s ?? 0;
    const mimeType = parsed.mimeType ?? parsed.mime ?? parsed.type ?? parsed.mt ?? inferMimeTypeFromFileName(fileName);
    const chunkSize = parsed.chunkSize ?? parsed.chunk ?? parsed.cs ?? 1024;
    const totalChunks = parsed.totalChunks ?? parsed.total ?? parsed.chunks ?? parsed.n ?? 1;
    const checksum = parsed.checksum ?? parsed.hash ?? parsed.sha256 ?? parsed.c ?? '';

    return {
      fileName,
      fileSize,
      mimeType,
      chunkSize,
      totalChunks,
      checksum,
    };
  } catch {
    return {};
  }
}

export function inferMimeTypeFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'pdf': return 'application/pdf';
    case 'txt': return 'text/plain';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

export function calculateFrameChecksum(payload: string): string {
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const char = payload.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function calculateSHA256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function reconstructFile(
  dataFrames: Map<number, FramePayload>,
  parityFrames: Map<number, FramePayload>,
  metadata: TransferMetadata
): Promise<Uint8Array> {
  const totalChunks = metadata.totalChunks;
  const chunks: (Uint8Array | undefined)[] = new Array(totalChunks);

  // Determine if frame indices are 0-indexed or 1-indexed
  const keys = Array.from(dataFrames.keys());
  const isZeroBased = keys.includes(0);

  for (const [index, frame] of dataFrames) {
    const targetIdx = isZeroBased ? index : index - 1;
    if (targetIdx >= 0 && targetIdx < totalChunks) {
      chunks[targetIdx] = base64ToArrayBuffer(frame.payload);
    }
  }

  // Identify missing chunks
  const missingIndices: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!chunks[i]) missingIndices.push(i);
  }

  // Parity recovery if missing frames exist
  if (missingIndices.length > 0 && parityFrames.size > 0) {
    for (const [_, frame] of parityFrames) {
      if (missingIndices.length === 0) break;
      const parityData = base64ToArrayBuffer(frame.payload);
      const rawIdx = isZeroBased ? frame.frameIndex : frame.frameIndex - 1;
      const groupIndex = Math.max(0, rawIdx % 5);

      const groupSourceIndices: number[] = [];
      for (let i = groupIndex; i < totalChunks; i += 5) {
        groupSourceIndices.push(i);
      }

      const missingInGroup = groupSourceIndices.filter(idx => missingIndices.includes(idx));
      if (missingInGroup.length === 1) {
        const targetIdx = missingInGroup[0];
        const recovered = new Uint8Array(parityData);

        for (const srcIdx of groupSourceIndices) {
          if (srcIdx !== targetIdx && chunks[srcIdx]) {
            for (let k = 0; k < recovered.length; k++) {
              recovered[k] ^= chunks[srcIdx]![k];
            }
          }
        }

        chunks[targetIdx] = recovered;
        const idxInMissing = missingIndices.indexOf(targetIdx);
        if (idxInMissing !== -1) missingIndices.splice(idxInMissing, 1);
      }
    }
  }

  // Combine all valid chunks into single Uint8Array
  const validChunks = chunks.filter((c): c is Uint8Array => c !== undefined);
  const totalLength = validChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return result;
}

export function base64ToArrayBuffer(base64: string): Uint8Array {
  const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
  const sanitized = cleanBase64.replace(/\s/g, '');
  const binary = atob(sanitized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
