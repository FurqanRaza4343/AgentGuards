import * as THREE from 'three';

export type Expression = 'eyes' | 'thinking' | 'alert' | 'success' | 'fail' | 'quote';

const COLOUR: Record<Expression, string> = {
  eyes: '#ffffff',
  thinking: '#ffffff',
  alert: '#ff5560',
  success: '#b9ffd9',
  fail: '#ff9b8a',
  quote: '#ffffff',
};

/**
 * The robot's face: a 512px canvas used as the emissive map of the screen plate.
 * Black fill, glowing shapes. Blinks every 2.5-5.5s, and fades each new expression in.
 */
export class FaceScreen {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private expr: Expression = 'eyes';
  private alpha = 1;
  private dirty = true;
  private blinkAt = -1;
  private nextBlink = 2.5 + Math.random() * 3;
  private eyeScale = 1;

  constructor() {
    this.canvas.width = this.canvas.height = 512;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.draw(0, false);
  }

  /** Switch expression. `fadeFrom` is the starting alpha of the fade-in (+0.05 per frame). */
  set(expr: Expression, fadeFrom = 0) {
    if (expr === this.expr) return;
    this.expr = expr;
    this.alpha = fadeFrom;
    this.blinkAt = -1;
    this.eyeScale = 1;
    this.dirty = true;
  }

  update(t: number, reduced: boolean) {
    let redraw = this.dirty;
    this.dirty = false;

    if (this.alpha < 1) {
      this.alpha = Math.min(1, this.alpha + 0.05);
      redraw = true;
    }
    if (this.expr === 'eyes') {
      if (this.blinkAt < 0 && t > this.nextBlink) this.blinkAt = t;
      if (this.blinkAt >= 0) {
        const k = (t - this.blinkAt) / 0.18;
        if (k >= 1) {
          this.blinkAt = -1;
          this.eyeScale = 1;
          this.nextBlink = t + 2.5 + Math.random() * 3;
        } else {
          this.eyeScale = 1 - 0.9 * Math.sin(Math.PI * k);
        }
        redraw = true;
      }
    }
    if (this.expr === 'thinking' && !reduced) redraw = true;
    if (redraw) this.draw(t, reduced);
  }

  private ellipse(x: number, y: number, rx: number, ry: number) {
    const c = this.ctx;
    c.beginPath();
    c.ellipse(x, y, rx, Math.max(ry, 0.6), 0, 0, Math.PI * 2);
    c.fill();
  }

  private draw(t: number, reduced: boolean) {
    const c = this.ctx;
    const colour = COLOUR[this.expr];
    c.globalAlpha = 1;
    c.shadowBlur = 0;
    c.fillStyle = '#000';
    c.fillRect(0, 0, 512, 512);

    c.globalAlpha = this.alpha;
    c.fillStyle = colour;
    c.strokeStyle = colour;
    c.shadowColor = colour;
    c.shadowBlur = 18;
    c.lineCap = 'round';

    switch (this.expr) {
      case 'eyes':
        this.ellipse(196, 262, 30, 38 * this.eyeScale);
        this.ellipse(316, 252, 30, 38 * this.eyeScale);
        break;

      case 'thinking':
        for (let i = 0; i < 3; i++) {
          const pulse = reduced ? 0.5 : Math.max(0, Math.sin(t * 6 - i * 0.9));
          this.ellipse(176 + i * 80, 262, 16 + 8 * pulse, 16 + 8 * pulse);
        }
        break;

      case 'alert':
        this.ellipse(196, 270, 30, 34);
        this.ellipse(316, 262, 30, 34);
        c.lineWidth = 15;
        c.beginPath();
        c.moveTo(136, 196);
        c.lineTo(236, 226);
        c.moveTo(376, 190);
        c.lineTo(276, 222);
        c.stroke();
        break;

      case 'success':
        c.lineWidth = 17;
        for (const [x, y] of [[196, 278], [316, 268]] as const) {
          c.beginPath();
          c.arc(x, y, 36, Math.PI * 1.12, Math.PI * 1.88);
          c.stroke();
        }
        break;

      case 'fail':
        c.lineWidth = 15;
        for (const [x, y] of [[196, 262], [316, 252]] as const) {
          c.beginPath();
          c.moveTo(x - 28, y - 28);
          c.lineTo(x + 28, y + 28);
          c.moveTo(x + 28, y - 28);
          c.lineTo(x - 28, y + 28);
          c.stroke();
        }
        c.lineWidth = 12;
        c.beginPath();
        c.moveTo(206, 384);
        c.lineTo(306, 384);
        c.stroke();
        break;

      case 'quote':
        c.font = '900 560px "Arial Black", Arial, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('“', 256, 400);
        break;
    }

    c.globalAlpha = 1;
    c.shadowBlur = 0;
    this.texture.needsUpdate = true;
  }
}
