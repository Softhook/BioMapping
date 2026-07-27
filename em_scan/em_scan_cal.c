// em_scan_cal.c — EM Scanner Hardware Faraday Calibration Data & Persistence.

#include "em_scan_cal.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint32_t em_scan_cal_compute_crc(const EmScanCal* cal) {
    if(!cal) return 0;
    const uint8_t* p = (const uint8_t*)cal;
    size_t n = offsetof(EmScanCal, crc32);
    uint32_t crc = 0xFFFFFFFFu;
    for(size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for(int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (-(int32_t)(crc & 1)));
        }
    }
    return ~crc;
}

bool em_scan_cal_validate(const EmScanCal* cal) {
    if(!cal) return false;
    if(cal->magic != EM_SCAN_CAL_MAGIC) return false;
    if(cal->version != EM_SCAN_CAL_VERSION) return false;
    if(cal->crc32 != em_scan_cal_compute_crc(cal)) return false;

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        float floor = cal->noise_floor_dbm[i];
        if(isnan(floor) || floor < EM_SCAN_CAL_MIN_FLOOR_DBM || floor > EM_SCAN_CAL_MAX_FLOOR_DBM) {
            return false;
        }
        float std_dev = cal->noise_std_dev_db[i];
        if(isnan(std_dev) || std_dev < 0.0f || std_dev >= EM_SCAN_CAL_MAX_STD_DEV_DB) {
            return false;
        }
    }
    return true;
}

bool em_scan_cal_load(EmScanCal* cal, Storage* storage) {
    if(!cal || !storage) return false;
    memset(cal, 0, sizeof(EmScanCal));

    File* file = storage_file_alloc(storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, EM_SCAN_CAL_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        uint16_t bytes_read = storage_file_read(file, cal, sizeof(EmScanCal));
        if(bytes_read == sizeof(EmScanCal)) {
            success = em_scan_cal_validate(cal);
        }
        storage_file_close(file);
    }
    storage_file_free(file);
    return success;
}

bool em_scan_cal_save(const EmScanCal* cal, Storage* storage) {
    if(!cal || !storage) return false;
    EmScanCal temp_cal = *cal;
    temp_cal.magic = EM_SCAN_CAL_MAGIC;
    temp_cal.version = EM_SCAN_CAL_VERSION;
    temp_cal.crc32 = em_scan_cal_compute_crc(&temp_cal);

    if(!em_scan_cal_validate(&temp_cal)) return false;

    storage_common_mkdir(storage, "/ext/biomapping");

    File* file = storage_file_alloc(storage);
    if(!file) return false;

    const char* tmp_path = "/ext/biomapping/em_scan_cal.bin.tmp";
    bool success = false;
    if(storage_file_open(file, tmp_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        uint16_t written = storage_file_write(file, &temp_cal, sizeof(EmScanCal));
        if(written == sizeof(EmScanCal)) {
            success = true;
        }
        storage_file_close(file);
    }
    storage_file_free(file);

    if(success) {
        FS_Error err = storage_common_rename(storage, tmp_path, EM_SCAN_CAL_PATH);
        if(err != FSE_OK && err != FSE_EXIST) {
            // fallback overwrite if rename doesn't replace
            storage_common_remove(storage, EM_SCAN_CAL_PATH);
            err = storage_common_rename(storage, tmp_path, EM_SCAN_CAL_PATH);
        }
        success = (err == FSE_OK);
    }
    return success;
}

void em_scan_cal_reset(Storage* storage) {
    if(!storage) return;
    storage_common_remove(storage, EM_SCAN_CAL_PATH);
    storage_common_remove(storage, "/ext/biomapping/em_scan_cal.bin.tmp");
}

static void sort_floats(float* arr, uint32_t n) {
    for(uint32_t i = 1; i < n; i++) {
        float key = arr[i];
        int32_t j = (int32_t)i - 1;
        while(j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = key;
    }
}

void em_scan_cal_compute_stats(
    const float samples[][EM_SCAN_NUM_FREQS],
    uint32_t count,
    float noise_floor_dbm[EM_SCAN_NUM_FREQS],
    float noise_std_dev_db[EM_SCAN_NUM_FREQS])
{
    if(!samples || !noise_floor_dbm || !noise_std_dev_db) return;

    if(count == 0) {
        for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
            noise_floor_dbm[b] = EM_SCAN_CAL_MIN_FLOOR_DBM;
            noise_std_dev_db[b] = 0.0f;
        }
        return;
    }

    float band_vals[64];
    uint32_t n = (count > 64) ? 64 : count;

    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        float sum = 0.0f;
        for(uint32_t i = 0; i < n; i++) {
            band_vals[i] = samples[i][b];
            sum += samples[i][b];
        }

        // Calculate mean & standard deviation
        float mean = sum / (float)n;
        float variance_sum = 0.0f;
        for(uint32_t i = 0; i < n; i++) {
            float diff = samples[i][b] - mean;
            variance_sum += diff * diff;
        }
        noise_std_dev_db[b] = sqrtf(variance_sum / (float)n);

        // Calculate 10th percentile noise floor
        sort_floats(band_vals, n);
        uint32_t p10_idx = n / 10;
        if(p10_idx >= n) p10_idx = n - 1;
        float floor = band_vals[p10_idx];
        if(floor < EM_SCAN_CAL_MIN_FLOOR_DBM) floor = EM_SCAN_CAL_MIN_FLOOR_DBM;
        if(floor > EM_SCAN_CAL_MAX_FLOOR_DBM) floor = EM_SCAN_CAL_MAX_FLOOR_DBM;
        noise_floor_dbm[b] = floor;
    }
}
