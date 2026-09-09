// Portable validation-only reader for the established PIV v5 frame grammar.
// No scene data, Python objects, pointers or allocations cross this C ABI.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>
#include <vector>

#if defined(_WIN32)
#define STYK_EXPORT extern "C" __declspec(dllexport)
#else
#define STYK_EXPORT extern "C" __attribute__((visibility("default")))
#endif

struct StykScanResult {
    std::uint64_t end_offset, error_offset, pose_bytes;
    std::uint32_t frame_count, error_frame, error_object, error_code;
};
static_assert(sizeof(StykScanResult) == 40, "Unexpected scan ABI alignment");

namespace {
enum Error : std::uint32_t {
    Ok = 0, Eof = 1, FrameCount = 2, Budget = 3, Background = 4,
    FigureType = 5, Nonfinite = 6, IdentityOrder = 7, ChangedType = 8,
    JoinSlot = 9, JoinHandle = 10, JoinCycle = 11, DrawOrder = 12,
    Metadata = 13, OutputCapacity = 14, Allocation = 15, Internal = 16
};
struct Failure { Error code; std::uint64_t offset; };

class Reader {
public:
    const std::uint8_t* bytes;
    std::uint64_t size, pos;
    Reader(const std::uint8_t* value, std::uint64_t length, std::uint64_t start = 0)
        : bytes(value), size(length), pos(start) {}
    void require(std::uint64_t count) const {
        if (pos > size || count > size - pos) throw Failure{Eof, pos};
    }
    std::uint8_t u8() { require(1); return bytes[pos++]; }
    std::uint16_t u16() {
        require(2); const auto p = bytes + pos; pos += 2;
        return static_cast<std::uint16_t>(p[0] | (static_cast<std::uint16_t>(p[1]) << 8));
    }
    std::uint32_t u32() {
        require(4); const auto p = bytes + pos; pos += 4;
        return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
            (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
    }
    void skip(std::uint64_t count) { require(count); pos += count; }
    void finite(std::uint32_t count, std::uint32_t width) {
        const std::uint64_t length = static_cast<std::uint64_t>(count) * width;
        require(length);
        // Inspect IEEE exponent bits directly. This is endian independent and
        // preserves finite subnormals and signed zero without FPU conversion.
        const auto* p = bytes + pos;
        for (std::uint32_t i = 0; i < count; ++i, p += width) {
            const bool invalid = width == 8 ?
                ((p[7] & 0x7f) == 0x7f && (p[6] & 0xf0) == 0xf0) :
                ((p[3] & 0x7f) == 0x7f && (p[2] & 0x80) == 0x80);
            if (invalid) throw Failure{Nonfinite, pos + static_cast<std::uint64_t>(i) * width};
        }
        pos += length;
    }
};

struct Definition {
    std::uint16_t id = 0, count = 0;
    bool media = false;
    std::vector<std::uint16_t> handles;
};

std::int64_t signed_uid(std::uint32_t uid) {
    return static_cast<std::int64_t>(uid) - (uid >= 0x80000000u ? 0x100000000ll : 0ll);
}

void reserve_pose(std::uint64_t bytes, std::uint64_t maximum, StykScanResult& result, const Reader& reader) {
    if (result.pose_bytes > maximum || bytes > maximum - result.pose_bytes)
        throw Failure{Budget, reader.pos};
    result.pose_bytes += bytes;
}

void scan(Reader& reader, const std::uint8_t* metadata, std::uint64_t metadata_size,
          std::uint32_t background_slots, std::uint64_t budget, std::uint16_t* durations,
          std::uint32_t capacity, StykScanResult& result) {
    if (!metadata || metadata_size > 64ull * 1024 * 1024 || background_slots < 1 || background_slots > 65535)
        throw Failure{Metadata, reader.pos};
    Reader definitions(metadata, metadata_size);
    std::vector<Definition> types;
    std::vector<const Definition*> by_id(65536, nullptr);
    try {
        const auto count = definitions.u32();
        if (count > 65535) throw Failure{Metadata, reader.pos};
        types.reserve(count);
        for (std::uint32_t i = 0; i < count; ++i) {
            Definition type;
            type.id = definitions.u16(); type.count = definitions.u16();
            const auto media = definitions.u8(), reserved = definitions.u8();
            const auto handle_count = definitions.u16();
            if (type.id == 0 || by_id[type.id] || type.count == 0 || type.count > 30000 || media > 1 ||
                reserved != 0 || handle_count != type.count + 1) throw Failure{Metadata, reader.pos};
            type.media = media != 0;
            type.handles.reserve(handle_count);
            for (std::uint32_t h = 0; h < handle_count; ++h) type.handles.push_back(definitions.u16());
            std::sort(type.handles.begin(), type.handles.end());
            if (type.handles.front() != 0 ||
                std::adjacent_find(type.handles.begin(), type.handles.end()) != type.handles.end())
                throw Failure{Metadata, reader.pos};
            types.push_back(std::move(type));
            by_id[types.back().id] = &types.back();
        }
        if (definitions.pos != definitions.size) throw Failure{Metadata, reader.pos};
    } catch (const Failure&) { throw Failure{Metadata, reader.pos}; }

    const auto frame_count = reader.u32(); result.frame_count = frame_count;
    if (frame_count > 1000000) throw Failure{FrameCount, reader.pos - 4};
    reserve_pose(static_cast<std::uint64_t>(frame_count) * 512, budget, result, reader);
    if (frame_count > capacity || (frame_count && !durations)) throw Failure{OutputCapacity, reader.pos};
    std::vector<std::uint32_t> identities, previous_ids;
    std::vector<std::uint16_t> frame_types, previous_types, join_handles;
    std::vector<std::int32_t> join_slots;
    std::vector<std::uint8_t> checked;
    for (std::uint32_t fi = 0; fi < frame_count; ++fi) {
        result.error_frame = fi; result.error_object = std::numeric_limits<std::uint32_t>::max();
        const auto duration = reader.u16(); const auto mix = reader.u8();
        const auto background = reader.u16(); const auto background_b = mix ? reader.u16() : 0u;
        if (background >= background_slots || (mix && background_b >= background_slots))
            throw Failure{Background, reader.pos};
        const auto object_count = reader.u16();
        reserve_pose(static_cast<std::uint64_t>(object_count) * 512, budget, result, reader);
        identities.resize(object_count); frame_types.resize(object_count);
        join_slots.assign(object_count, -1); join_handles.resize(object_count);
        auto previous_signed = -0x80000001ll;
        std::size_t previous_cursor = 0;
        for (std::uint32_t oi = 0; oi < object_count; ++oi) {
            result.error_object = oi;
            const auto uid = reader.u32(); const auto tid = reader.u16();
            const auto* type = by_id[tid];
            if (!type) throw Failure{FigureType, reader.pos};
            reader.finite(1, 4); reader.skip(5); // Scale, color and transparency.
            const auto signed_value = signed_uid(uid);
            if (signed_value <= previous_signed) throw Failure{IdentityOrder, reader.pos};
            previous_signed = signed_value;
            while (previous_cursor < previous_ids.size() && signed_uid(previous_ids[previous_cursor]) < signed_value)
                ++previous_cursor;
            if (previous_cursor < previous_ids.size() && previous_ids[previous_cursor] == uid &&
                previous_types[previous_cursor] != tid) throw Failure{ChangedType, reader.pos};
            if (type->media) reader.skip(1);
            reserve_pose(static_cast<std::uint64_t>(type->count) * 24, budget, result, reader);
            reader.finite(type->count, 8); reader.finite(2, 4);
            if (reader.u16()) {
                reserve_pose(static_cast<std::uint64_t>(type->count) * 24, budget, result, reader);
                reader.finite(type->count, 4);
            }
            if (reader.u16()) {
                reserve_pose(static_cast<std::uint64_t>(type->count) * 24, budget, result, reader);
                reader.finite(type->count, 8);
            }
            if (reader.u8()) {
                reserve_pose(64, budget, result, reader);
                const auto target = reader.u16(), handle = reader.u16();
                if (target >= object_count) throw Failure{JoinSlot, reader.pos};
                join_slots[oi] = target; join_handles[oi] = handle;
            }
            identities[oi] = uid; frame_types[oi] = tid;
        }
        for (std::uint32_t oi = 0; oi < object_count; ++oi) {
            result.error_object = oi;
            const auto slot = join_slots[oi];
            if (slot >= 0) {
                const auto* target = by_id[frame_types[static_cast<std::size_t>(slot)]];
                if (!std::binary_search(target->handles.begin(), target->handles.end(), join_handles[oi]))
                    throw Failure{JoinHandle, reader.pos};
            }
        }
        checked.assign(object_count, 0);
        for (std::uint32_t oi = 0; oi < object_count; ++oi) {
            result.error_object = oi;
            auto cursor = static_cast<std::int32_t>(oi);
            while (cursor >= 0 && checked[static_cast<std::size_t>(cursor)] == 0) {
                checked[static_cast<std::size_t>(cursor)] = 1;
                cursor = join_slots[static_cast<std::size_t>(cursor)];
            }
            if (cursor >= 0 && checked[static_cast<std::size_t>(cursor)] == 1)
                throw Failure{JoinCycle, reader.pos};
            cursor = static_cast<std::int32_t>(oi);
            while (cursor >= 0 && checked[static_cast<std::size_t>(cursor)] == 1) {
                checked[static_cast<std::size_t>(cursor)] = 2;
                cursor = join_slots[static_cast<std::size_t>(cursor)];
            }
        }
        checked.assign(object_count, 0);
        result.error_object = std::numeric_limits<std::uint32_t>::max();
        for (std::uint32_t oi = 0; oi < object_count; ++oi) {
            const auto slot = reader.u16();
            if (slot >= object_count || checked[slot]) throw Failure{DrawOrder, reader.pos};
            checked[slot] = 1;
        }
        if (!reader.u8()) { reader.finite(2, 4); reader.finite(1, 8); reader.finite(1, 4); }
        durations[fi] = duration;
        if (duration > 1) { previous_ids = identities; previous_types = frame_types; }
        else { previous_ids.clear(); previous_types.clear(); }
    }
}
} // namespace

STYK_EXPORT std::uint32_t styk_piv_scan_abi() { return 1; }
STYK_EXPORT std::uint32_t styk_piv_scan_result_size() { return static_cast<std::uint32_t>(sizeof(StykScanResult)); }

STYK_EXPORT std::uint32_t styk_piv_scan(const std::uint8_t* data, std::uint64_t size, std::uint64_t start,
    const std::uint8_t* metadata, std::uint64_t metadata_size, std::uint32_t background_slots,
    std::uint64_t budget, std::uint16_t* durations, std::uint32_t capacity, StykScanResult* output) {
    if (!output) return Internal;
    *output = {}; output->end_offset = start;
    output->error_frame = output->error_object = std::numeric_limits<std::uint32_t>::max();
    Reader reader(data, size, start);
    try {
        if (!data || size > 256ull * 1024 * 1024 || start > size) throw Failure{Eof, start};
        scan(reader, metadata, metadata_size, background_slots, budget, durations, capacity, *output);
    } catch (const Failure& error) {
        output->error_code = error.code; output->error_offset = error.offset;
    } catch (const std::bad_alloc&) { output->error_code = Allocation; output->error_offset = reader.pos; }
    catch (...) { output->error_code = Internal; output->error_offset = reader.pos; }
    output->end_offset = reader.pos;
    return output->error_code;
}
