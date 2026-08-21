CONTRACT := comp-shared-lock
TARGET := riscv64imac-unknown-none-elf
CLANG ?= $(shell command -v clang)
LLVM_AR ?= $(shell command -v llvm-ar)

# Match the current ckb-script-templates RISC-V configuration. Rust 1.95+
# requires lower-atomic for CKB-VM, which does not implement atomic opcodes.
CKB_RUSTFLAGS := -C target-feature=+zba,+zbb,+zbc,+zbs -C passes=lower-atomic -C link-arg=-s

build:
	RUSTFLAGS="$(CKB_RUSTFLAGS)" TARGET_CC="$(CLANG)" TARGET_AR="$(LLVM_AR)" \
		cargo build --target $(TARGET) --release -p $(CONTRACT)
	mkdir -p build/release
	cp target/$(TARGET)/release/$(CONTRACT) build/release/

test: build
	cargo test -p tests -- --nocapture

clean:
	cargo clean
	rm -rf build

prepare:
	rustup target add $(TARGET)

.PHONY: build test clean prepare
