import { FilesetResolver, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './body';

// Models are served locally from public/mediapipe (see scripts/fetch-models.mjs); frames never leave the browser.
const BASE = '/mediapipe';
const SEG_W = 256;

export type TrackerResult = {
  landmarks: Landmark[] | null;
  world: { x: number; y: number; z: number }[] | null;
  mask: { data: Float32Array; width: number; height: number } | null;
};

export class Tracker {
  private constructor(
    private pose: PoseLandmarker,
    private segmenter: ImageSegmenter | null,
    public delegate: 'GPU' | 'CPU',
  ) {}

  static async create(): Promise<Tracker> {
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        const pose = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_full.task`, delegate },
          runningMode: 'VIDEO',
          numPoses: 1, // shortcut: tracks the most prominent person only; multi-person kiosks need person selection
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        let segmenter: ImageSegmenter | null = null;
        try {
          segmenter = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: `${BASE}/selfie_segmenter.tflite`, delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
        } catch (e) {
          console.warn('person segmentation unavailable', e);
        }
        return new Tracker(pose, segmenter, delegate);
      } catch (e) {
        if (delegate === 'CPU') throw e;
        console.warn('GPU delegate failed, falling back to CPU', e);
      }
    }
    throw new Error('unreachable');
  }

  get hasSegmentation() {
    return this.segmenter !== null;
  }

  private segCanvas: HTMLCanvasElement | null = null;

  detect(video: HTMLVideoElement, tMs: number, withMask: boolean): TrackerResult {
    const pose = this.pose.detectForVideo(video, tMs);
    const landmarks = pose.landmarks[0] ?? null;
    let mask: TrackerResult['mask'] = null;
    if (withMask && this.segmenter && landmarks) {
      // Low-res segmentation: the mask only feeds silhouette widths and soft shadows, so 256 px wide is plenty.
      // Video, image or canvas source.
      const vw = video.videoWidth || (video as unknown as HTMLImageElement).naturalWidth || video.width;
      const vh = video.videoHeight || (video as unknown as HTMLImageElement).naturalHeight || video.height;
      const c = (this.segCanvas ??= document.createElement('canvas'));
      if (c.width !== SEG_W) { c.width = SEG_W; c.height = Math.round((SEG_W * vh) / vw); }
      c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
      this.segmenter.segmentForVideo(c, tMs, (res) => {
        const m = res.confidenceMasks?.[0];
        if (m) mask = { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height };
      });
    }
    return { landmarks, world: pose.worldLandmarks?.[0] ?? null, mask };
  }

  close() {
    this.pose.close();
    this.segmenter?.close();
  }
}
