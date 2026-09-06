// The repo Abi with the memory views cached until the buffer is replaced by a
// grow. Scratch only.
import { Abi as Base } from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/abi.ts";
export class Abi extends Base {
  declare private cb?: ArrayBuffer;
  declare private cbytes?: Uint8Array;
  declare private cview?: DataView;
  bytes() {
    const buffer = (this.exports.memory as WebAssembly.Memory).buffer;
    if (buffer !== this.cb) {
      this.cb = buffer;
      this.cbytes = new Uint8Array(buffer);
      this.cview = new DataView(buffer);
    }
    return this.cbytes!;
  }
  view() {
    this.bytes();
    return this.cview!;
  }
}
