/** Controls pause/resume/cancel for the agent loop without interrupting mid-turn execution. */
export class InterruptionController {
    private state: 'running' | 'paused' | 'cancelled' = 'running';
    private resumePromise?: {
        resolve: () => void;
        reject: (error: Error) => void;
    };

    /** Pause the loop after the current turn completes. */
    pause(): void {
        if (this.state === 'running') {
            this.state = 'paused';
        }
    }

    /** Resume a paused loop. */
    resume(): void {
        if (this.state === 'paused') {
            this.state = 'running';
            if (this.resumePromise) {
                this.resumePromise.resolve();
                this.resumePromise = undefined;
            }
        }
    }

    /** Permanently cancel the loop. Cannot be resumed after cancellation. */
    cancel(): void {
        this.state = 'cancelled';
        if (this.resumePromise) {
            this.resumePromise.reject(new Error('Loop cancelled'));
            this.resumePromise = undefined;
        }
    }

    /** Check whether the loop has been cancelled and should stop execution. */
    shouldStop(): boolean {
        return this.state === 'cancelled';
    }

    /** Check whether the loop is currently paused. */
    isPaused(): boolean {
        return this.state === 'paused';
    }

    /** Blocks until resume() or cancel() is called. Used internally by the loop. */
    async waitForResume(): Promise<void> {
        if (this.state !== 'paused') {
            return;
        }

        return new Promise((resolve, reject) => {
            this.resumePromise = { resolve, reject };
        });
    }

    /** Reset the controller to the running state, clearing any pause/cancel state. */
    reset(): void {
        this.state = 'running';
        this.resumePromise = undefined;
    }
}
