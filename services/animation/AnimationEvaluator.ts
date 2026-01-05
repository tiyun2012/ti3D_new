
import { AnimationTrack } from '../../types';
import { QuatUtils, Vec3Utils } from '../math';

export class AnimationEvaluator {
    
    /**
     * Optimized evaluation using Binary Search for keyframes
     */
    static evaluateTrack(track: AnimationTrack, time: number): Float32Array {
        const times = track.times;
        const values = track.values;
        const count = times.length;

        // 1. Handle edge cases
        if (count === 0) return new Float32Array(track.type === 'rotation' ? [0,0,0,1] : [0,0,0]);
        if (time <= times[0]) return this.getValue(track, 0);
        if (time >= times[count - 1]) return this.getValue(track, count - 1);

        // 2. Binary Search for the keyframe index (O(log n))
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
        
        // idx is the insertion point or exact match from the loop.
        // We want the frame *before* or *at* the time.
        // The implementation logic suggests idx tracks the upper bound in standard bisect_right logic if condition is <=
        // Let's rely on standard binary search behavior finding the element.
        // If times[mid] <= time, we moved low up. The last valid idx where times[idx] <= time is what we want.
        // Refined logic:
        // We want `i` such that `times[i] <= time < times[i+1]`
        
        // Since we did `low = mid + 1` when `<=`, idx (which was set to mid) is a candidate.
        // The loop finishes when low > high.
        // Let's refine the search for clarity:
        
        low = 0; 
        high = count - 1;
        
        while (low <= high) {
            const mid = (low + high) >>> 1;
            if (times[mid] <= time) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        // `idx` holds the index of the largest time value <= `time`

        // 3. Interpolate
        const t1 = times[idx];
        const nextIdx = Math.min(idx + 1, count - 1);
        const t2 = times[nextIdx];
        
        let factor = 0;
        if (t2 > t1) {
            factor = (time - t1) / (t2 - t1);
        }
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
