CONTRACT := comp-shared-lock
TARGET := riscv64imac-unknown-none-elf

build:
	RUSTFLAGS="-C target-feature=-a -C link-arg=-s" cargo build --target $(TARGET) --release -p $(CONTRACT)
	mkdir -p build/release
	cp target/$(TARGET)/release/$(CONTRACT) build/release/

test: build
	cargo test -p tests -- --nocapture

clean:
	cargo clean
	rm -rf build

.PHONY: build test clean
