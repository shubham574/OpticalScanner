import { useRef, useState, useCallback, useEffect, useId } from 'react';
import { Camera as CapCamera } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import jsQR from 'jsqr';
import { 
  Camera, 
  Download, 
  AlertCircle, 
  RotateCcw, 
  ShieldCheck, 
  Sparkles,
  FileCheck,
  Share2,
  ExternalLink,
  Image as ImageIcon,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  SwitchCamera,
  Flashlight,
  Upload,
  ZoomIn,
  X,
  History,
  Copy,
  Check,
  Maximize2
} from 'lucide-react';
import { 
  decodeFrame, 
  parseMetadata,
  parseSingleQrContent,
  reconstructFile, 
  calculateSHA256, 
  formatFileSize, 
  inferMimeTypeFromFileName,
  playSuccessSound,
  triggerHaptic,
  type FramePayload, 
  type TransferMetadata 
} from './lib/protocol';

interface HistoryItem {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  imageUrl?: string;
  timestamp: string;
  blob?: Blob;
}

export default function App() {
  const fileInputId = useId();
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  
  const [metadata, setMetadata] = useState<TransferMetadata | null>(null);
  const [, setDataFrames] = useState<Map<number, FramePayload>>(new Map());
  const [, setParityFrames] = useState<Map<number, FramePayload>>(new Map());
  
  const [status, setStatus] = useState<'idle' | 'scanning' | 'receiving' | 'reconstructing' | 'complete' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checksumWarning, setChecksumWarning] = useState<string | null>(null);
  
  const [receivedCount, setReceivedCount] = useState(0);
  const [reconstructedBlob, setReconstructedBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isFullscreenModalOpen, setIsFullscreenModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const animRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dataFramesRef = useRef<Map<number, FramePayload>>(new Map());
  const parityFramesRef = useRef<Map<number, FramePayload>>(new Map());
  const metadataRef = useRef<TransferMetadata | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const lastScannedQrRef = useRef<{ text: string; time: number }>({ text: '', time: 0 });

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      if (imageUrl && imageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [imageUrl]);

  const stopCamera = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
    setTorchOn(false);
    setStatus(prev => prev === 'scanning' ? 'idle' : prev);
  }, []);

  const addHistoryItem = useCallback((item: HistoryItem) => {
    setHistory(prev => [item, ...prev.slice(0, 19)]);
  }, []);

  const completeSingleImageScan = useCallback((result: ReturnType<typeof parseSingleQrContent>) => {
    stopCamera();
    playSuccessSound();
    triggerHaptic();

    const fullMeta: TransferMetadata = {
      transferId: `single_${Date.now()}`,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
      chunkSize: result.fileSize,
      totalChunks: 1,
      checksum: '',
      protocolVersion: 1,
      isSingleQr: true,
      rawText: result.rawText,
    };

    metadataRef.current = fullMeta;
    setMetadata(fullMeta);
    if (result.blob) {
      setReconstructedBlob(result.blob);
    }
    if (result.imageUrl) {
      setImageUrl(result.imageUrl);
      // Measure dimensions
      const img = new Image();
      img.onload = () => {
        setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.src = result.imageUrl;
    }
    setStatus('complete');

    addHistoryItem({
      id: fullMeta.transferId,
      fileName: fullMeta.fileName,
      mimeType: fullMeta.mimeType,
      fileSize: fullMeta.fileSize,
      imageUrl: result.imageUrl,
      blob: result.blob,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }, [stopCamera, addHistoryItem]);

  const processCompleteTransfer = useCallback(async () => {
    const meta = metadataRef.current;
    if (!meta || isProcessingRef.current) return;
    isProcessingRef.current = true;

    setStatus('reconstructing');
    stopCamera();

    try {
      const data = await reconstructFile(dataFramesRef.current, parityFramesRef.current, meta);
      
      if (meta.checksum && meta.checksum.length > 0) {
        const computedHash = await calculateSHA256(data);
        if (computedHash.toLowerCase() !== meta.checksum.toLowerCase()) {
          console.warn('Checksum mismatch:', computedHash, 'vs expected', meta.checksum);
          setChecksumWarning('SHA-256 Checksum mismatch. File reconstructed with potential parity recovery.');
        }
      }

      const mimeType = meta.mimeType || inferMimeTypeFromFileName(meta.fileName);
      const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType });
      setReconstructedBlob(blob);

      const isImg = mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(meta.fileName);
      let createdUrl: string | undefined;
      if (isImg) {
        createdUrl = URL.createObjectURL(blob);
        setImageUrl(createdUrl);
        const img = new Image();
        img.onload = () => {
          setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.src = createdUrl;
      }

      playSuccessSound();
      triggerHaptic();
      setStatus('complete');

      addHistoryItem({
        id: meta.transferId,
        fileName: meta.fileName,
        mimeType: mimeType,
        fileSize: blob.size,
        imageUrl: createdUrl,
        blob: blob,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    } catch (e) {
      console.error('Reconstruction error:', e);
      setErrorMessage('Failed to reconstruct file from received frames.');
      setStatus('error');
    } finally {
      isProcessingRef.current = false;
    }
  }, [stopCamera, addHistoryItem]);

  // QR Decoder handler for both multi-frame protocol & direct single QR codes
  const handleFrameDecoded = useCallback((qrText: string) => {
    if (!qrText) return;

    // Prevent immediate duplicate firing on identical static single QR
    const now = Date.now();
    if (lastScannedQrRef.current.text === qrText && now - lastScannedQrRef.current.time < 800) {
      return;
    }
    lastScannedQrRef.current = { text: qrText, time: now };

    const frame = decodeFrame(qrText);

    // 1. If it matches LightDrop animated transfer protocol
    if (frame) {
      if (frame.frameType === 'metadata') {
        const parsedMeta = parseMetadata(frame.payload);
        const fullMeta: TransferMetadata = {
          transferId: frame.transferId,
          fileName: parsedMeta.fileName || 'scanned_file',
          fileSize: parsedMeta.fileSize || 0,
          mimeType: parsedMeta.mimeType || inferMimeTypeFromFileName(parsedMeta.fileName || ''),
          chunkSize: parsedMeta.chunkSize || 1024,
          totalChunks: parsedMeta.totalChunks || frame.totalFrames || 1,
          checksum: parsedMeta.checksum || '',
          protocolVersion: frame.protocolVersion || 1,
        };
        metadataRef.current = fullMeta;
        setMetadata(fullMeta);
        setStatus('receiving');
        return;
      }

      if (frame.frameType === 'data') {
        if (!dataFramesRef.current.has(frame.frameIndex)) {
          dataFramesRef.current.set(frame.frameIndex, frame);
          const nextData = new Map(dataFramesRef.current);
          setDataFrames(nextData);
          setReceivedCount(nextData.size);

          const currentMeta = metadataRef.current;
          if (currentMeta && nextData.size >= currentMeta.totalChunks) {
            processCompleteTransfer();
          }
        }
      } else if (frame.frameType === 'parity') {
        if (!parityFramesRef.current.has(frame.frameIndex)) {
          parityFramesRef.current.set(frame.frameIndex, frame);
          setParityFrames(new Map(parityFramesRef.current));
        }
      } else if (frame.frameType === 'complete') {
        processCompleteTransfer();
      }
      return;
    }

    // 2. Direct Single QR Code (Image URL, Data URI Base64, JSON image, or Raw Text)
    const singleResult = parseSingleQrContent(qrText);
    
    // If it's a web URL but not automatically parsed as an image, let's try to fetch it
    if (!singleResult.isImage && /^https?:\/\//i.test(qrText.trim())) {
      setStatus('receiving');
      stopCamera();
      fetch(qrText.trim())
        .then(async (res) => {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.startsWith('image/')) {
            const blob = await res.blob();
            const ext = contentType.split('/')[1] || 'png';
            completeSingleImageScan({
              isImage: true,
              blob,
              imageUrl: URL.createObjectURL(blob),
              fileName: `fetched_image_${Date.now()}.${ext}`,
              fileSize: blob.size,
              mimeType: contentType,
              rawText: qrText
            });
          } else if (contentType.includes('application/json')) {
            const text = await res.text();
            const parsed = parseSingleQrContent(text);
            if (parsed.isImage) {
              completeSingleImageScan(parsed);
            } else {
              completeSingleImageScan({
                isImage: false,
                fileName: 'fetched_data.json',
                fileSize: new Blob([text]).size,
                mimeType: 'application/json',
                rawText: text
              });
            }
          } else {
            const text = await res.text();
            completeSingleImageScan({
              isImage: false,
              fileName: 'fetched_content.txt',
              fileSize: new Blob([text]).size,
              mimeType: contentType || 'text/plain',
              rawText: text
            });
          }
        })
        .catch(err => {
          console.error('Fetch error:', err);
          completeSingleImageScan(singleResult);
        });
      return;
    }

    completeSingleImageScan(singleResult);
  }, [processCompleteTransfer, completeSingleImageScan, stopCamera]);

  const startCamera = async (overrideFacing?: 'environment' | 'user') => {
    setCameraError(null);
    setErrorMessage(null);
    const mode = overrideFacing || facingMode;

    try {
      // If running inside Capacitor (Android/iOS APK), we must explicitly request native camera permissions first
      if (Capacitor.isNativePlatform()) {
        try {
          const status = await CapCamera.requestPermissions();
          if (status.camera !== 'granted' && status.camera !== 'prompt-with-rationale') {
            throw new Error('Camera permission not granted by device.');
          }
        } catch (e) {
          console.warn('Capacitor camera permission request failed:', e);
        }
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch (err) {
        // Fallback if facingMode or ideal resolution fails (common on some laptops or webviews)
        console.warn('Primary camera constraints failed, trying fallback...', err);
        stream = await navigator.mediaDevices.getUserMedia({
          video: true
        });
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(e => console.warn('Video play error:', e));
      }

      // Check if torch/flashlight is supported
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchSupported(Boolean(capabilities?.torch));

      setIsScanning(true);
      if (status === 'idle' || status === 'complete' || status === 'error') {
        setStatus('scanning');
      }

      // Frame capture loop
      const scanLoop = () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
          // Crop to a square in the center to reduce jsQR load and focus on the reticle
          const size = Math.min(video.videoWidth, video.videoHeight);
          const startX = (video.videoWidth - size) / 2;
          const startY = (video.videoHeight - size) / 2;

          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, startX, startY, size, size, 0, 0, size, size);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'attemptBoth',
            });
            if (code && code.data) {
              handleFrameDecoded(code.data);
            }
          }
        }
        animRef.current = requestAnimationFrame(scanLoop);
      };

      scanLoop();
    } catch (err) {
      console.error('Camera access error:', err);
      setCameraError(err instanceof Error ? err.message : 'Could not access camera permissions. Please grant camera access in settings.');
      setIsScanning(false);
    }
  };

  const toggleCameraFacing = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    if (isScanning) {
      startCamera(nextMode);
    }
  };

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track) {
      try {
        const nextState = !torchOn;
        await track.applyConstraints({
          // @ts-expect-error Torch constraint
          advanced: [{ torch: nextState }]
        });
        setTorchOn(nextState);
      } catch (err) {
        console.warn('Torch toggle failed', err);
      }
    }
  };

  const handleGalleryUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imgData.data, imgData.width, imgData.height, {
            inversionAttempts: 'attemptBoth',
          });
          if (code && code.data) {
            handleFrameDecoded(code.data);
          } else {
            setErrorMessage('No valid QR code found in selected image.');
            setStatus('error');
          }
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const resetAll = () => {
    stopCamera();
    if (imageUrl && imageUrl.startsWith('blob:')) {
      URL.revokeObjectURL(imageUrl);
    }
    metadataRef.current = null;
    dataFramesRef.current.clear();
    parityFramesRef.current.clear();
    isProcessingRef.current = false;
    lastScannedQrRef.current = { text: '', time: 0 };

    setMetadata(null);
    setDataFrames(new Map());
    setParityFrames(new Map());
    setReceivedCount(0);
    setReconstructedBlob(null);
    setImageUrl(null);
    setImageDimensions(null);
    setStatus('idle');
    setErrorMessage(null);
    setChecksumWarning(null);
    setIsFullscreenModalOpen(false);
  };

  const downloadFile = () => {
    if (imageUrl) {
      const a = document.createElement('a');
      a.href = imageUrl;
      a.download = metadata?.fileName || `scanned_image_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (reconstructedBlob && metadata) {
      const url = URL.createObjectURL(reconstructedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const shareFile = async () => {
    if (navigator.share) {
      try {
        if (reconstructedBlob && metadata) {
          const file = new File([reconstructedBlob], metadata.fileName, { type: metadata.mimeType });
          await navigator.share({
            title: metadata.fileName,
            files: [file],
          });
          return;
        } else if (metadata?.rawText) {
          await navigator.share({
            title: metadata.fileName,
            text: metadata.rawText,
            url: imageUrl || undefined,
          });
          return;
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Share error:', err);
          downloadFile();
        }
      }
    } else {
      downloadFile();
    }
  };

  const copyContent = () => {
    const textToCopy = metadata?.rawText || imageUrl || metadata?.fileName || '';
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const openInNewTab = () => {
    if (imageUrl) {
      window.open(imageUrl, '_blank');
    } else if (reconstructedBlob) {
      const url = URL.createObjectURL(reconstructedBlob);
      window.open(url, '_blank');
    }
  };

  const progressPct = metadata && metadata.totalChunks > 0 
    ? Math.min(100, Math.round((receivedCount / metadata.totalChunks) * 100)) 
    : 0;

  return (
    <div className="min-h-screen bg-[#07090e] text-white flex flex-col justify-between p-4 max-w-md mx-auto select-none font-sans relative overflow-x-hidden">
      
      {/* Top App Bar Header */}
      <header className="flex items-center justify-between py-2 border-b border-gray-800/70">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.25)]">
            <Sparkles className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg leading-tight tracking-tight text-white flex items-center gap-1.5">
              <span>OpticalDrop</span>
              <span className="text-[10px] uppercase font-bold tracking-widest bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded-md">PRO</span>
            </h1>
            <span className="text-[11px] text-gray-400 font-medium">QR Scanner & Image Renderer</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setShowHistory(!showHistory)} 
            className="p-2 rounded-xl bg-gray-900/80 border border-gray-800 text-gray-300 hover:text-emerald-400 transition"
            title="Scan History"
          >
            <History className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1 bg-emerald-950/40 border border-emerald-500/30 rounded-full px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Ready</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col justify-center my-3 space-y-3.5">
        
        {/* Main Display Container (Camera Viewport OR Completed Image Preview) */}
        <div className="relative aspect-square w-full bg-black/90 rounded-3xl overflow-hidden border border-gray-800/90 shadow-[0_0_35px_rgba(0,0,0,0.8)] flex items-center justify-center">
          
          {/* Active Camera Viewport */}
          {isScanning && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover absolute inset-0"
            />
          )}

          {/* Scanner Overlay HUD & Animated Reticle */}
          {isScanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-between p-4 pointer-events-none z-10">
              
              {/* Top Controls on Camera */}
              <div className="w-full flex justify-between items-center pointer-events-auto">
                <div className="bg-black/60 backdrop-blur-md border border-gray-700/60 rounded-full px-3 py-1 text-[11px] font-medium text-emerald-300 flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span>Scanning Active</span>
                </div>

                <div className="flex items-center gap-2">
                  {torchSupported && (
                    <button
                      onClick={toggleTorch}
                      className={`p-2 rounded-full backdrop-blur-md border transition ${
                        torchOn 
                          ? 'bg-yellow-500/20 border-yellow-400 text-yellow-300 shadow-[0_0_15px_rgba(234,179,8,0.4)]' 
                          : 'bg-black/60 border-gray-700 text-gray-300'
                      }`}
                      title="Toggle Flashlight"
                    >
                      <Flashlight className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={toggleCameraFacing}
                    className="p-2 rounded-full bg-black/60 border border-gray-700 text-gray-300 hover:text-white backdrop-blur-md transition"
                    title="Switch Front/Back Camera"
                  >
                    <SwitchCamera className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Central Target Reticle */}
              <div className="relative w-[78%] aspect-square border-2 border-emerald-400/40 rounded-3xl shadow-[0_0_30px_rgba(16,185,129,0.15)] flex items-center justify-center">
                {/* 4 Tech Corner Brackets */}
                <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-emerald-400 -mt-1 -ml-1 rounded-tl-xl shadow-[0_0_10px_#10b981]" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-emerald-400 -mt-1 -mr-1 rounded-tr-xl shadow-[0_0_10px_#10b981]" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-emerald-400 -mb-1 -ml-1 rounded-bl-xl shadow-[0_0_10px_#10b981]" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-emerald-400 -mb-1 -mr-1 rounded-br-xl shadow-[0_0_10px_#10b981]" />
                
                {/* Laser scan bar */}
                <div className="w-full h-1 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_15px_#10b981] animate-scan absolute left-0" />
              </div>

              <div className="text-[11px] text-gray-300 font-medium bg-black/60 backdrop-blur-md px-3.5 py-1 rounded-full border border-gray-800 pointer-events-auto">
                Align QR code within target frame
              </div>
            </div>
          )}

          {/* Scanned Image Preview Display (When Complete!) */}
          {status === 'complete' && imageUrl && !isScanning && (
            <div className="relative w-full h-full bg-black flex flex-col items-center justify-center group overflow-hidden">
              <img 
                src={imageUrl} 
                alt={metadata?.fileName || 'Scanned Image'} 
                className="w-full h-full object-contain cursor-pointer transition duration-300 hover:scale-[1.02]"
                onClick={() => setIsFullscreenModalOpen(true)}
              />

              {/* Format & Dimensions Badge */}
              <div className="absolute top-3 left-3 bg-black/80 backdrop-blur-md border border-emerald-500/40 rounded-xl px-2.5 py-1 text-[11px] font-semibold text-emerald-300 flex items-center gap-1.5 shadow-lg">
                <ImageIcon className="w-3.5 h-3.5" />
                <span>{metadata?.mimeType ? metadata.mimeType.replace('image/', '').toUpperCase() : 'IMAGE'}</span>
                {imageDimensions && (
                  <span className="text-gray-400 font-mono font-normal">({imageDimensions.width}×{imageDimensions.height})</span>
                )}
              </div>

              {/* Fullscreen zoom action */}
              <button 
                onClick={() => setIsFullscreenModalOpen(true)}
                className="absolute top-3 right-3 bg-black/80 hover:bg-black border border-gray-700 text-gray-200 p-2 rounded-xl text-xs flex items-center gap-1.5 backdrop-blur-md transition shadow-lg"
                title="View Fullscreen"
              >
                <ZoomIn className="w-4 h-4 text-emerald-400" />
                <span>Zoom</span>
              </button>

              <button 
                onClick={openInNewTab}
                className="absolute bottom-3 right-3 bg-black/80 hover:bg-black border border-gray-700 text-gray-200 p-2 rounded-xl text-xs flex items-center gap-1.5 backdrop-blur-md transition shadow-lg"
                title="Open in new window"
              >
                <ExternalLink className="w-4 h-4 text-emerald-400" />
                <span>Open URL</span>
              </button>
            </div>
          )}

          {/* Non-image File Complete Screen */}
          {status === 'complete' && !imageUrl && !isScanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-gray-950">
              <div className="w-20 h-20 bg-emerald-500/10 border border-emerald-500/30 rounded-3xl flex items-center justify-center mb-4 text-emerald-400 shadow-[0_0_30px_rgba(16,185,129,0.15)]">
                <FileCheck className="w-10 h-10" />
              </div>
              <h3 className="font-bold text-base text-emerald-300 mb-1 max-w-[260px] truncate">{metadata?.fileName}</h3>
              <p className="text-xs text-gray-400 font-mono mb-3">
                {metadata?.fileSize ? formatFileSize(metadata.fileSize) : 'Text Content'} • {metadata?.mimeType}
              </p>
              {metadata?.rawText && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 max-h-28 overflow-y-auto w-full text-left text-xs font-mono text-gray-300 break-all select-text">
                  {metadata.rawText}
                </div>
              )}
              {metadata?.rawText && /^https?:\/\//i.test(metadata.rawText.trim()) && (
                <button
                  onClick={() => window.open(metadata.rawText?.trim(), '_blank')}
                  className="mt-3 w-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 rounded-xl flex items-center justify-center gap-2 shadow-lg text-xs"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Open URL in Browser</span>
                </button>
              )}
            </div>
          )}

          {/* Reconstructing Loader */}
          {status === 'reconstructing' && !isScanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-gray-950/95 z-20">
              <div className="relative mb-3">
                <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
                <Sparkles className="w-5 h-5 text-emerald-300 absolute inset-0 m-auto animate-pulse" />
              </div>
              <h3 className="font-bold text-base text-gray-100">Rendering Scanned Image...</h3>
              <p className="text-xs text-gray-400 mt-1 max-w-[240px]">Reconstructing packet chunks & validating data integrity</p>
            </div>
          )}

          {/* Idle Camera Placeholder */}
          {!isScanning && status === 'idle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-gradient-to-b from-gray-900/80 to-gray-950">
              <div className="w-20 h-20 rounded-3xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3.5 shadow-[0_0_25px_rgba(16,185,129,0.15)]">
                <Camera className="w-10 h-10 text-emerald-400" />
              </div>
              <h3 className="font-bold text-lg text-white mb-1">Point & Scan QR Code</h3>
              <p className="text-xs text-gray-400 max-w-[260px] leading-relaxed">
                Scan single QR images or streaming optical transmissions to instantly render images on your phone.
              </p>

              <div className="mt-4 flex gap-2">
                <label 
                  htmlFor={fileInputId}
                  className="bg-gray-900/90 border border-gray-700/80 hover:border-emerald-500/50 hover:bg-gray-800 text-gray-200 text-xs font-semibold px-3.5 py-2 rounded-xl flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Pick from Gallery</span>
                </label>
                <input 
                  id={fileInputId}
                  ref={fileInputRef}
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  onChange={handleGalleryUpload} 
                />
              </div>
            </div>
          )}
        </div>

        {/* Live Multi-chunk Transfer Status Card */}
        {metadata && status !== 'complete' && !metadata.isSingleQr && (
          <div className="bg-gray-900/95 border border-gray-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-gray-100 truncate max-w-[190px]" title={metadata.fileName}>
                {metadata.fileName}
              </span>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-0.5 rounded-full font-semibold">
                {formatFileSize(metadata.fileSize)}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="space-y-1.5">
              <div className="h-3 w-full bg-gray-800 rounded-full overflow-hidden p-0.5 border border-gray-700/50">
                <div 
                  className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 rounded-full transition-all duration-300 shadow-[0_0_12px_#10b981]"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 font-mono">
                <span className="text-emerald-400 font-bold">{progressPct}% Complete</span>
                <span>{receivedCount} / {metadata.totalChunks} Chunks</span>
              </div>
            </div>

            {receivedCount >= metadata.totalChunks && (
              <button
                onClick={processCompleteTransfer}
                className="w-full mt-1 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 text-emerald-300 font-bold py-2.5 rounded-xl text-xs flex items-center justify-center gap-2 transition shadow-lg"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Complete Image Render</span>
              </button>
            )}
          </div>
        )}

        {/* Completion Card with Save to Phone, Share, Copy & Info */}
        {status === 'complete' && metadata && (
          <div className="bg-gradient-to-b from-emerald-950/30 to-gray-900/95 border border-emerald-500/40 rounded-2xl p-4 text-center space-y-3.5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-400 font-extrabold text-base">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span>Scan Successful!</span>
              </div>
              <button
                onClick={copyContent}
                className="flex items-center gap-1 bg-gray-800/90 border border-gray-700 rounded-lg px-2.5 py-1 text-[11px] text-gray-300 hover:text-white transition"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            
            <div className="text-xs text-gray-300 font-medium truncate bg-black/40 border border-gray-800/80 rounded-xl px-3 py-2 text-left flex justify-between items-center">
              <span className="truncate pr-2 font-mono">{metadata.fileName}</span>
              {metadata.fileSize > 0 && (
                <span className="text-emerald-400 font-mono font-semibold flex-shrink-0">
                  {formatFileSize(metadata.fileSize)}
                </span>
              )}
            </div>

            {checksumWarning && (
              <div className="bg-amber-950/50 border border-amber-500/40 rounded-xl p-2.5 text-left flex items-start gap-2 text-[11px] text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <span>{checksumWarning}</span>
              </div>
            )}

            {/* Mobile Actions Grid */}
            <div className="grid grid-cols-2 gap-2.5 pt-0.5">
              <button
                onClick={downloadFile}
                className="bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition text-xs active:scale-[0.98]"
              >
                <Download className="w-4 h-4" />
                <span>Save to Phone</span>
              </button>

              <button
                onClick={shareFile}
                className="bg-gray-800 border border-gray-700 hover:bg-gray-750 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg transition text-xs active:scale-[0.98]"
              >
                <Share2 className="w-4 h-4 text-emerald-400" />
                <span>Share Image</span>
              </button>
            </div>
          </div>
        )}

        {/* Scan History Drawer / Modal */}
        {showHistory && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-3.5 space-y-3 shadow-2xl max-h-64 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2">
              <h3 className="font-bold text-xs text-gray-200 flex items-center gap-1.5">
                <History className="w-4 h-4 text-emerald-400" />
                <span>Recent Scanned Images ({history.length})</span>
              </h3>
              {history.length > 0 && (
                <button 
                  onClick={() => setHistory([])}
                  className="text-[10px] text-red-400 hover:underline"
                >
                  Clear All
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-4">No scanned images yet</p>
            ) : (
              <div className="space-y-2">
                {history.map((item) => (
                  <div key={item.id} className="bg-black/50 border border-gray-800/80 rounded-xl p-2 flex items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg flex-shrink-0 border border-gray-700" />
                      ) : (
                        <div className="w-10 h-10 bg-emerald-500/10 rounded-lg flex items-center justify-center flex-shrink-0 text-emerald-400">
                          <FileCheck className="w-5 h-5" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-gray-200 truncate">{item.fileName}</div>
                        <div className="text-[10px] text-gray-400 font-mono">{item.timestamp} • {formatFileSize(item.fileSize)}</div>
                      </div>
                    </div>
                    {item.imageUrl && (
                      <button 
                        onClick={() => {
                          setImageUrl(item.imageUrl || null);
                          setMetadata({
                            transferId: item.id,
                            fileName: item.fileName,
                            fileSize: item.fileSize,
                            mimeType: item.mimeType,
                            chunkSize: item.fileSize,
                            totalChunks: 1,
                            checksum: '',
                            protocolVersion: 1,
                          });
                          setStatus('complete');
                          setShowHistory(false);
                        }}
                        className="p-1.5 bg-gray-800 hover:bg-gray-700 text-emerald-400 rounded-lg text-xs"
                        title="View"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Error Banner */}
        {(cameraError || errorMessage) && (
          <div className="bg-red-950/70 border border-red-500/50 rounded-2xl p-3.5 flex items-start gap-3 shadow-xl">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-red-200 leading-relaxed font-medium">
              {cameraError || errorMessage}
            </div>
          </div>
        )}
      </main>

      {/* Footer Floating Action Buttons */}
      <footer className="pt-2">
        {status !== 'complete' ? (
          <div className="flex gap-2.5">
            <button
              onClick={isScanning ? stopCamera : () => startCamera()}
              className={`flex-1 font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2.5 shadow-xl transition active:scale-[0.98] ${
                isScanning 
                  ? 'bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700' 
                  : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.35)]'
              }`}
            >
              <Camera className="w-5 h-5" />
              <span className="text-sm">{isScanning ? 'Stop Camera' : 'Start Camera Scanner'}</span>
            </button>

            <label 
              htmlFor={fileInputId}
              className="bg-gray-900 border border-gray-800 hover:bg-gray-800 text-gray-200 p-4 rounded-2xl flex items-center justify-center transition cursor-pointer"
              title="Pick QR from gallery"
            >
              <Upload className="w-5 h-5 text-emerald-400" />
            </label>

            {(metadata || isScanning) && (
              <button
                onClick={resetAll}
                className="bg-gray-900 border border-gray-800 hover:bg-gray-800 text-gray-300 p-4 rounded-2xl flex items-center justify-center transition"
                title="Reset Scanner"
              >
                <RotateCcw className="w-5 h-5" />
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => {
              resetAll();
              startCamera();
            }}
            className="w-full bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-black font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2.5 shadow-[0_0_25px_rgba(16,185,129,0.35)] transition active:scale-[0.98]"
          >
            <Camera className="w-5 h-5" />
            <span className="text-sm">Scan Another QR Image</span>
          </button>
        )}
      </footer>

      {/* Fullscreen High-Resolution Image Zoom Modal */}
      {isFullscreenModalOpen && imageUrl && (
        <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-xl flex flex-col justify-between p-4 animate-in fade-in duration-200">
          <div className="flex items-center justify-between border-b border-gray-800/80 pb-3">
            <div className="flex items-center gap-2 truncate max-w-[240px]">
              <ImageIcon className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-gray-200 truncate">{metadata?.fileName}</span>
            </div>
            <button
              onClick={() => setIsFullscreenModalOpen(false)}
              className="p-2 rounded-full bg-gray-900 border border-gray-800 text-gray-300 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 flex items-center justify-center p-2 overflow-auto">
            <img 
              src={imageUrl} 
              alt={metadata?.fileName || 'Fullscreen Image'} 
              className="max-w-full max-h-[75vh] object-contain rounded-2xl shadow-2xl border border-gray-800"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={downloadFile}
              className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg text-xs"
            >
              <Download className="w-4 h-4" />
              <span>Save Image</span>
            </button>
            <button
              onClick={shareFile}
              className="flex-1 bg-gray-900 border border-gray-800 hover:bg-gray-800 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg text-xs"
            >
              <Share2 className="w-4 h-4 text-emerald-400" />
              <span>Share</span>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
