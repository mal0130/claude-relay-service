#!/bin/bash

# Claude Relay Service - 同步上游版本脚本
# 用于检查和合并上游仓库的更新

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m' # No Color

# 上游仓库配置
UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/Wei-Shaw/claude-relay-service.git"
UPSTREAM_BRANCH="main"

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# 检查是否在 git 仓库中
check_git_repo() {
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "当前目录不是 git 仓库"
        exit 1
    fi
}

# 检查并配置 upstream remote
check_upstream_remote() {
    print_info "检查 upstream 远程仓库配置..."

    if ! git remote | grep -q "^${UPSTREAM_REMOTE}$"; then
        print_warning "未找到 upstream 远程仓库，正在添加..."
        git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
        print_success "已添加 upstream 远程仓库"
    else
        # 验证 URL 是否正确
        CURRENT_URL=$(git remote get-url "$UPSTREAM_REMOTE")
        if [ "$CURRENT_URL" != "$UPSTREAM_URL" ]; then
            print_warning "upstream URL 不正确，正在更新..."
            git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
            print_success "已更新 upstream URL"
        fi
    fi
}

# 获取上游更新
fetch_upstream() {
    print_info "获取上游仓库更新..."
    if ! git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"; then
        print_error "获取上游更新失败，请检查网络连接"
        exit 1
    fi
    print_success "上游更新获取成功"
}

# 检查版本变化
check_version() {
    print_info "检查版本变化..."
    echo ""

    # 获取本地版本
    if [ ! -f "VERSION" ]; then
        print_error "未找到 VERSION 文件"
        exit 1
    fi
    LOCAL_VERSION=$(cat VERSION | tr -d '[:space:]')

    # 获取上游版本
    UPSTREAM_VERSION=$(git show "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:VERSION" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$UPSTREAM_VERSION" ]; then
        print_error "无法获取上游版本号"
        exit 1
    fi

    echo -e "${BLUE}本地版本:${NC} ${GREEN}$LOCAL_VERSION${NC}"
    echo -e "${BLUE}上游版本:${NC} ${GREEN}$UPSTREAM_VERSION${NC}"
    echo ""

    if [ "$LOCAL_VERSION" = "$UPSTREAM_VERSION" ]; then
        print_success "版本已是最新 ($LOCAL_VERSION)"
        return 1
    else
        print_warning "检测到上游版本更新！"
        echo ""
        echo -e "${YELLOW}📊 版本变化：${NC}"
        echo -e "  ${LOCAL_VERSION} → ${UPSTREAM_VERSION}"
        return 0
    fi
}

# 显示上游更新内容
show_upstream_changes() {
    echo ""
    echo -e "${YELLOW}📝 上游最近更新：${NC}"
    git log HEAD.."${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" --oneline --max-count=10

    echo ""
    echo -e "${YELLOW}📁 文件变更统计：${NC}"
    git diff --stat HEAD.."${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
}

# 检查本地是否有未提交的修改
check_local_changes() {
    if ! git diff-index --quiet HEAD --; then
        print_error "检测到未提交的本地修改"
        echo ""
        echo "请先提交或暂存本地修改："
        git status --short
        echo ""
        echo "建议操作："
        echo "  git add ."
        echo "  git commit -m \"your message\""
        echo "  或者: git stash"
        exit 1
    fi
}

# 合并上游更新
merge_upstream() {
    print_info "正在合并上游更新..."

    # 获取上游版本号用于提交消息
    UPSTREAM_VERSION=$(git show "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:VERSION" 2>/dev/null | tr -d '[:space:]')

    # 执行合并
    if git merge "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" -m "chore: 同步上游版本 ${UPSTREAM_VERSION}"; then
        print_success "合并成功！"
        return 0
    else
        print_error "合并时发生冲突"
        echo ""
        echo -e "${YELLOW}冲突文件：${NC}"
        git status --short | grep "^UU"
        echo ""
        echo "请手动解决冲突后执行："
        echo "  git add ."
        echo "  git commit"
        echo "  git push origin main"
        exit 1
    fi
}

# 推送更新到远程仓库
push_changes() {
    print_info "推送到远程仓库..."

    if git push origin main; then
        print_success "推送成功！"
        return 0
    else
        print_error "推送失败"
        echo ""
        echo "请手动推送："
        echo "  git push origin main"
        exit 1
    fi
}

# 显示最终总结
show_summary() {
    local version=$1
    echo ""
    echo "======================================"
    print_success "同步完成！"
    echo "======================================"
    echo ""
    echo -e "${BLUE}📦 新版本：${NC} ${GREEN}${version}${NC}"
    echo ""
    echo -e "${BLUE}📦 GitHub Actions 将自动：${NC}"
    echo "  1. 构建前端（版本 ${version}）"
    echo "  2. 创建 tag: v${version}"
    echo "  3. 创建 GitHub Release"
    echo ""
    echo -e "${BLUE}🔗 查看构建进度：${NC}"
    echo "  https://github.com/mal0130/claude-relay-service/actions"
    echo ""
}

# 显示帮助信息
show_help() {
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --check-only    仅检查更新，不执行合并"
    echo "  -h, --help      显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0              # 完整同步流程"
    echo "  $0 --check-only # 仅检查更新"
}

# 主函数
main() {
    local check_only=false

    # 解析命令行参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            --check-only)
                check_only=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                print_error "未知选项: $1"
                show_help
                exit 1
                ;;
        esac
    done

    echo ""
    echo "======================================"
    echo "  Claude Relay Service - 同步上游版本"
    echo "======================================"
    echo ""

    # 1. 检查是否在 git 仓库中
    check_git_repo

    # 2. 检查并配置 upstream remote
    check_upstream_remote

    # 3. 获取上游更新
    fetch_upstream

    # 4. 检查版本变化
    if ! check_version; then
        # 版本已是最新，无需继续
        exit 0
    fi

    # 5. 显示上游更新内容
    show_upstream_changes

    # 6. 如果只是检查模式，到此结束
    if [ "$check_only" = true ]; then
        echo ""
        print_info "检查完成（--check-only 模式）"
        echo ""
        echo "如需合并更新，请运行："
        echo "  $0"
        exit 0
    fi

    # 7. 询问用户是否继续
    echo ""
    echo -n "是否合并上游更新？(y/N): "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        print_warning "已取消同步"
        exit 0
    fi

    # 8. 检查本地是否有未提交的修改
    check_local_changes

    # 9. 合并上游更新
    merge_upstream

    # 10. 推送到远程仓库
    push_changes

    # 11. 获取新版本号
    NEW_VERSION=$(cat VERSION | tr -d '[:space:]')

    # 12. 显示最终总结
    show_summary "$NEW_VERSION"
}

# 执行主函数
main "$@"
