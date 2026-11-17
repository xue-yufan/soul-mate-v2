#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

namespace {

constexpr int VERSION = 1;
constexpr std::size_t MAX_INPUT_CHARS = 16 * 1024 * 1024;
constexpr std::size_t MAX_IMAGE_BYTES = 8 * 1024 * 1024;

constexpr std::string_view BASE64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::vector<std::uint8_t> decode_base64(std::string_view input) {
    std::array<int, 256> table{};
    table.fill(-1);
    for (std::size_t index = 0; index < BASE64_ALPHABET.size(); ++index) {
        table[static_cast<unsigned char>(BASE64_ALPHABET[index])] = static_cast<int>(index);
    }

    std::vector<std::uint8_t> output;
    output.reserve(input.size() * 3 / 4);
    int accumulator = 0;
    int bits = -8;
    for (const char raw : input) {
        const unsigned char ch = static_cast<unsigned char>(raw);
        if (ch == '=')
            break;
        if (ch == '\r' || ch == '\n' || ch == ' ' || ch == '\t')
            continue;
        const int value = table[ch];
        if (value < 0)
            throw std::runtime_error("invalid base64");
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 0) {
            output.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xff));
            bits -= 8;
        }
        if (output.size() > MAX_IMAGE_BYTES) {
            throw std::runtime_error("decoded image is too large");
        }
    }
    return output;
}

std::string encode_base64(const std::vector<std::uint8_t>& input) {
    std::string output;
    output.reserve((input.size() + 2) / 3 * 4);
    std::uint32_t accumulator = 0;
    int bits = -6;
    for (const std::uint8_t byte : input) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 0) {
            output.push_back(BASE64_ALPHABET[(accumulator >> bits) & 0x3f]);
            bits -= 6;
        }
    }
    if (bits > -6) {
        output.push_back(BASE64_ALPHABET[(accumulator << (-bits)) & 0x3f]);
    }
    while (output.size() % 4 != 0)
        output.push_back('=');
    return output;
}

double round_metric(double value) { return std::round(value * 100.0) / 100.0; }

std::string escape_json(std::string_view value) {
    std::string output;
    output.reserve(value.size() + 8);
    for (const char ch : value) {
        switch (ch) {
            case '\\':
                output += "\\\\";
                break;
            case '"':
                output += "\\\"";
                break;
            case '\n':
                output += "\\n";
                break;
            case '\r':
                output += "\\r";
                break;
            case '\t':
                output += "\\t";
                break;
            default:
                output.push_back(ch);
                break;
        }
    }
    return output;
}

std::string error_response(const std::string& message) {
    return "{\"v\":" + std::to_string(VERSION) + ",\"ok\":false,\"error\":\"" +
           escape_json(message) + "\"}";
}

std::string applied_json(const std::vector<std::string>& applied) {
    std::ostringstream stream;
    stream << "[";
    for (std::size_t index = 0; index < applied.size(); ++index) {
        if (index > 0)
            stream << ",";
        stream << "\"" << escape_json(applied[index]) << "\"";
    }
    stream << "]";
    return stream.str();
}

std::size_t find_json_value(std::string_view request, std::string_view key) {
    const std::string quoted = "\"" + std::string(key) + "\"";
    const std::size_t key_position = request.find(quoted);
    if (key_position == std::string_view::npos)
        return std::string_view::npos;
    const std::size_t colon = request.find(':', key_position + quoted.size());
    if (colon == std::string_view::npos)
        return std::string_view::npos;
    std::size_t value = colon + 1;
    while (value < request.size()) {
        const unsigned char ch = static_cast<unsigned char>(request[value]);
        if (ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n')
            break;
        ++value;
    }
    return value;
}

bool read_json_int(std::string_view request, std::string_view key, int& output) {
    const std::size_t value = find_json_value(request, key);
    if (value == std::string_view::npos || value >= request.size())
        return false;
    int sign = 1;
    std::size_t index = value;
    if (request[index] == '-') {
        sign = -1;
        ++index;
    }
    int parsed = 0;
    bool found = false;
    while (index < request.size()) {
        const char ch = request[index];
        if (ch < '0' || ch > '9')
            break;
        found = true;
        parsed = parsed * 10 + (ch - '0');
        ++index;
    }
    if (!found)
        return false;
    output = parsed * sign;
    return true;
}

bool read_json_string(std::string_view request, std::string_view key, std::string& output) {
    const std::size_t value = find_json_value(request, key);
    if (value == std::string_view::npos || value >= request.size() || request[value] != '"') {
        return false;
    }
    const std::size_t end = request.find('"', value + 1);
    if (end == std::string_view::npos)
        return false;
    output = std::string(request.substr(value + 1, end - value - 1));
    return !output.empty();
}

std::string process_image(std::string_view request_text) {
    const auto started = std::chrono::steady_clock::now();
    int version = 0;
    if (!read_json_int(request_text, "v", version)) {
        return error_response("request is not valid JSON");
    }
    if (version != VERSION) {
        return error_response("protocol version mismatch");
    }
    std::string image_base64;
    if (!read_json_string(request_text, "image", image_base64)) {
        return error_response("image must be a base64 string");
    }

    int max_edge = 1600;
    int jpeg_quality = 86;
    read_json_int(request_text, "max_edge", max_edge);
    read_json_int(request_text, "jpeg_quality", jpeg_quality);
    max_edge = std::clamp(max_edge, 256, 4096);
    jpeg_quality = std::clamp(jpeg_quality, 40, 100);

    const auto encoded = decode_base64(image_base64);
    cv::Mat source = cv::imdecode(encoded, cv::IMREAD_COLOR);
    if (source.empty())
        return error_response("OpenCV could not decode the image");

    const int original_width = source.cols;
    const int original_height = source.rows;
    cv::Mat working = source;
    std::vector<std::string> applied;

    const int longest = std::max(source.cols, source.rows);
    if (longest > max_edge) {
        const double scale = static_cast<double>(max_edge) / longest;
        cv::resize(source, working, cv::Size(), scale, scale, cv::INTER_AREA);
        applied.push_back("resize");
    }

    cv::Mat gray;
    cv::cvtColor(working, gray, cv::COLOR_BGR2GRAY);

    cv::Scalar mean;
    cv::Scalar deviation;
    cv::meanStdDev(gray, mean, deviation);
    const double brightness = mean[0];
    const double contrast = deviation[0];

    cv::Mat laplacian;
    cv::Laplacian(gray, laplacian, CV_64F);
    cv::Scalar lap_mean;
    cv::Scalar lap_deviation;
    cv::meanStdDev(laplacian, lap_mean, lap_deviation);
    const double blur_variance = lap_deviation[0] * lap_deviation[0];

    if (brightness < 60.0 || contrast < 30.0) {
        cv::Mat lab;
        cv::cvtColor(working, lab, cv::COLOR_BGR2Lab);
        std::vector<cv::Mat> channels;
        cv::split(lab, channels);
        cv::Ptr<cv::CLAHE> clahe = cv::createCLAHE(2.0, cv::Size(8, 8));
        clahe->apply(channels[0], channels[0]);
        cv::merge(channels, lab);
        cv::cvtColor(lab, working, cv::COLOR_Lab2BGR);
        applied.push_back("clahe");
    }

    if (blur_variance < 70.0) {
        cv::Mat blurred;
        cv::GaussianBlur(working, blurred, cv::Size(0, 0), 1.0);
        cv::addWeighted(working, 1.18, blurred, -0.18, 0.0, working);
        applied.push_back("unsharp");
    }

    std::vector<std::uint8_t> output;
    const std::vector<int> encode_options{cv::IMWRITE_JPEG_QUALITY, jpeg_quality};
    if (!cv::imencode(".jpg", working, output, encode_options)) {
        return error_response("OpenCV failed to encode the processed image");
    }
    if (output.size() > MAX_IMAGE_BYTES) {
        return error_response("processed image is too large");
    }

    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - started)
                             .count();
    std::ostringstream response;
    response << "{\"v\":" << VERSION << ",\"ok\":true,\"image\":\"" << encode_base64(output)
             << "\",\"mime_type\":\"image/jpeg\",\"metrics\":{"
             << "\"blur_variance\":" << round_metric(blur_variance)
             << ",\"brightness\":" << round_metric(brightness)
             << ",\"contrast\":" << round_metric(contrast)
             << ",\"original_width\":" << original_width
             << ",\"original_height\":" << original_height << ",\"width\":" << working.cols
             << ",\"height\":" << working.rows << "},\"applied\":" << applied_json(applied)
             << ",\"elapsed_ms\":" << elapsed << "}";
    return response.str();
}

} // namespace

int main() {
    std::ios::sync_with_stdio(false);
    try {
        std::string line;
        std::getline(std::cin, line);
        if (line.empty()) {
            std::cout << error_response("empty request") << '\n';
            return 0;
        }
        if (line.size() > MAX_INPUT_CHARS) {
            std::cout << error_response("request is too large") << '\n';
            return 0;
        }
        std::cout << process_image(line) << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cout << error_response(error.what()) << '\n';
        return 0;
    }
}
