cmake_minimum_required(VERSION 3.24)

project(soul_mate_vision_opencv LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenCV CONFIG REQUIRED COMPONENTS core imgproc imgcodecs)

add_executable(soul-mate-vision-opencv src/main.cpp)
target_compile_features(soul-mate-vision-opencv PRIVATE cxx_std_20)
target_link_libraries(
  soul-mate-vision-opencv
  PRIVATE
    ${OpenCV_LIBS}
)

if(MSVC)
  target_compile_options(soul-mate-vision-opencv PRIVATE /W4 /permissive-)
else()
  target_compile_options(soul-mate-vision-opencv PRIVATE -Wall -Wextra -Wpedantic)
endif()
