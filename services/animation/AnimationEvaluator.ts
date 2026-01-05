
import { AnimationTrack } from '../../types';
import { QuatUtils, Vec3Utils } from '../math';

export class AnimationEvaluator {
    
    /**
     * Optimized evaluation using Binary Search for keyframes.
     * This is O(log n) instead of O(n), critical for long clips.
     */
    static evaluateTrack(track: AnimationTrack, time: number): Float32Array {
        const times = track.times;
        const values = track.values;
        const count = times.length;

        // 1. Handle edge cases (empty or out of bounds)
        if (count === 0) return new Float32Array(track.type === 'rotation' ? [0,0,0,1] : [0,0,0]);
        if (time <= times[0]) return this.getValue(track, 0);
        if (time >= times[count - 1]) return this.getValue(track, count - 1);

        // 2. Binary Search for the keyframe index
        let low = 0;
        let high = count - 1;
        let idx = 0;

        while (low <= high) {
            const mid = (low + high) >>> 1;
            if (times[mid] <= time) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        // idx is now the frame *after* or *at* time, we need the one before
        // The binary search logic ensures we find the upper bound, so we adjust:
        idx = Math.max(0, idx - 1);

        // 3. Interpolate
        const t1 = times[idx];
        const t2 = times[idx + 1] || t1; // Safety check
        const factor = (time - t1) / (t2 - t1);
        const t = Math.max(0, Math.min(1, isNaN(factor) ? 0 : factor));

        if (track.type === 'rotation') {
            return this.interpolateRotation(values, idx, t);
        } else {
            return this.interpolateVector(values, idx, t);
        }
    }

    private static getValue(track: AnimationTrack, idx: number): Float32Array {
        const stride = track.type === 'rotation' ? 4 : 3;
        const start = idx * stride;
        return track.values.subarray(start, start + stride);
    }

    private static interpolateVector(values: Float32Array, idx: number, t: number): Float32Array {
        const start = idx * 3;
        const next = (idx + 1) * 3;
        
        const v1 = { x: values[start], y: values[start+1], z: values[start+2] };
        const v2 = { x: values[next], y: values[next+1], z: values[next+2] };
        const res = { x: 0, y: 0, z: 0 };
        
        Vec3Utils.lerp(v1, v2, t, res);
        return new Float32Array([res.x, res.y, res.z]);
    }

    private static interpolateRotation(values: Float32Array, idx: number, t: number): Float32Array {
        const start = idx * 4;
        const next = (idx + 1) * 4;

        const q1 = { x: values[start], y: values[start+1], z: values[start+2], w: values[start+3] };
        const q2 = { x: values[next], y: values[next+1], z: values[next+2], w: values[next+3] };
        const res = { x: 0, y: 0, z: 0, w: 1 };

        QuatUtils.slerp(q1, q2, t, res);
        return new Float32Array([res.x, res.y, res.z, res.w]);
    }
}
