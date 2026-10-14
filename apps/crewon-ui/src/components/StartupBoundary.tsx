import { Component, type ReactNode } from "react";

export class StartupBoundary extends Component<
  {
    children: ReactNode;
    onRetry?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crewon-startup" role="alert">
        <div>
          <p>页面资源加载失败，请重新加载。</p>
          <button
            type="button"
            onClick={this.props.onRetry ?? (() => location.reload())}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
